#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <netfw.h>
#include <sddl.h>
#include <winsvc.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cwctype>
#include <mutex>
#include <string>
#include <vector>

namespace {
template <typename T>
class ComPtr {
 public:
  ComPtr() = default;
  ~ComPtr() { if (value_) value_->Release(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  T* operator->() const { return value_; }
  T** put() { return &value_; }
 private:
  T* value_ = nullptr;
};

class ComApartment {
 public:
  ComApartment() : result_(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)) {}
  ~ComApartment() { if (SUCCEEDED(result_)) CoUninitialize(); }
  bool valid() const { return SUCCEEDED(result_); }
 private:
  HRESULT result_;
};

class BString {
 public:
  explicit BString(const wchar_t* value = nullptr)
      : value_(value ? SysAllocString(value) : nullptr) {}
  ~BString() { SysFreeString(value_); }
  BString(const BString&) = delete;
  BString& operator=(const BString&) = delete;
  BSTR get() const { return value_; }
  BSTR* put() { return &value_; }
  std::wstring text() const { return value_ ? value_ : L""; }
 private:
  BSTR value_;
};

struct NetworkCapability {
  bool available;
  const char* reason;
};

bool serviceRunning(SC_HANDLE manager, const wchar_t* name) {
  SC_HANDLE service = OpenServiceW(manager, name, SERVICE_QUERY_STATUS);
  if (!service) return false;
  SERVICE_STATUS_PROCESS status{};
  DWORD bytes = 0;
  const bool running = QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
      reinterpret_cast<LPBYTE>(&status), sizeof(status), &bytes) &&
      status.dwCurrentState == SERVICE_RUNNING;
  CloseServiceHandle(service);
  return running;
}

std::wstring normalized(const std::wstring& text) {
  std::wstring result;
  for (wchar_t ch : text) {
    if (!iswspace(ch)) result += static_cast<wchar_t>(towlower(ch));
  }
  return result;
}

std::vector<std::wstring> addressSet(const std::wstring& text) {
  std::vector<std::wstring> result;
  const auto value = normalized(text);
  size_t start = 0;
  do {
    const size_t end = value.find(L',', start);
    auto item = value.substr(start, end == std::wstring::npos ? end : end - start);
    // Firewall COM canonicalizes the official IPv4 mask and the singleton :: range.
    if (item == L"127.0.0.0/8") item = L"127.0.0.0/255.0.0.0";
    if (item == L"::") item = L"::-::";
    result.push_back(item);
    if (end == std::wstring::npos) break;
    start = end + 1;
  } while (true);
  std::sort(result.begin(), result.end());
  return result;
}

bool allPorts(const std::wstring& value) {
  const auto ports = normalized(value);
  return ports.empty() || ports == L"*" || ports == L"1-65535";
}

bool exactUser(BSTR value, PSID sid) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!value || !ConvertStringSecurityDescriptorToSecurityDescriptorW(
      value, SDDL_REVISION_1, &descriptor, nullptr)) return false;
  PACL acl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  void* rawAce = nullptr;
  bool valid = GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) &&
      present && acl && acl->AceCount == 1 && GetAce(acl, 0, &rawAce);
  if (valid) {
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
    valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
        ace->Header.AceFlags == 0 && ace->Mask == 1 &&
        IsValidSid(const_cast<DWORD*>(&ace->SidStart)) &&
        EqualSid(const_cast<DWORD*>(&ace->SidStart), sid);
  }
  LocalFree(descriptor);
  return valid;
}

bool offlineRule(INetFwRules* rules, const wchar_t* name,
                 NET_FW_RULE_DIRECTION expectedDirection, long expectedProtocol,
                 const wchar_t* expectedAddresses, PSID sid) {
  BString key(name);
  if (!key.get()) return false;
  ComPtr<INetFwRule> base;
  ComPtr<INetFwRule3> rule;
  if (FAILED(rules->Item(key.get(), base.put())) ||
      FAILED(base->QueryInterface(__uuidof(INetFwRule3),
          reinterpret_cast<void**>(rule.put())))) return false;
  VARIANT_BOOL enabled = VARIANT_FALSE;
  NET_FW_ACTION action = NET_FW_ACTION_ALLOW;
  NET_FW_RULE_DIRECTION direction = NET_FW_RULE_DIR_IN;
  long profiles = 0, protocol = 0;
  if (FAILED(rule->get_Enabled(&enabled)) || enabled != VARIANT_TRUE ||
      FAILED(rule->get_Action(&action)) || action != NET_FW_ACTION_BLOCK ||
      FAILED(rule->get_Direction(&direction)) || direction != expectedDirection ||
      FAILED(rule->get_Profiles(&profiles)) || (profiles & 7) != 7 ||
      FAILED(rule->get_Protocol(&protocol)) || protocol != expectedProtocol) return false;
  BString users, addresses, remotePorts, localPorts, localAddresses;
  BString application, service, interfaceTypes, remoteUsers, remoteMachines, package;
  if (FAILED(rule->get_LocalUserAuthorizedList(users.put())) || !exactUser(users.get(), sid) ||
      FAILED(rule->get_RemoteAddresses(addresses.put())) ||
      addressSet(addresses.text()) != addressSet(expectedAddresses) ||
      FAILED(rule->get_RemotePorts(remotePorts.put())) || !allPorts(remotePorts.text()) ||
      FAILED(rule->get_LocalPorts(localPorts.put())) || !allPorts(localPorts.text()) ||
      FAILED(rule->get_LocalAddresses(localAddresses.put())) || normalized(localAddresses.text()) != L"*" ||
      FAILED(rule->get_ApplicationName(application.put())) || !application.text().empty() ||
      FAILED(rule->get_ServiceName(service.put())) || !service.text().empty() ||
      FAILED(rule->get_InterfaceTypes(interfaceTypes.put())) || normalized(interfaceTypes.text()) != L"all" ||
      FAILED(rule->get_RemoteUserAuthorizedList(remoteUsers.put())) || !remoteUsers.text().empty() ||
      FAILED(rule->get_RemoteMachineAuthorizedList(remoteMachines.put())) || !remoteMachines.text().empty() ||
      FAILED(rule->get_LocalAppPackageId(package.put())) || !package.text().empty()) return false;
  VARIANT interfaces;
  VariantInit(&interfaces);
  const HRESULT result = rule->get_Interfaces(&interfaces);
  const bool allInterfaces = SUCCEEDED(result) &&
      (interfaces.vt == VT_EMPTY || interfaces.vt == VT_NULL);
  VariantClear(&interfaces);
  return allInterfaces;
}

// These are the fixed rust-v0.160.1 official offline rules. This query never
// provisions users, installs rules, reads account credentials, or caches readiness.
NetworkCapability offlineNetworkRules() {
  SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!manager) return {false, "firewall-service-unavailable"};
  const bool running = serviceRunning(manager, L"BFE") && serviceRunning(manager, L"mpssvc");
  CloseServiceHandle(manager);
  if (!running) return {false, "firewall-service-unavailable"};
  ComApartment apartment;
  if (!apartment.valid()) return {false, "network-policy-query-failed"};
  ComPtr<INetFwPolicy2> policy;
  if (FAILED(CoCreateInstance(__uuidof(NetFwPolicy2), nullptr, CLSCTX_INPROC_SERVER,
      __uuidof(INetFwPolicy2), reinterpret_cast<void**>(policy.put()))))
    return {false, "network-policy-query-failed"};
  for (const auto profile : {NET_FW_PROFILE2_DOMAIN, NET_FW_PROFILE2_PRIVATE, NET_FW_PROFILE2_PUBLIC}) {
    VARIANT_BOOL enabled = VARIANT_FALSE;
    if (FAILED(policy->get_FirewallEnabled(profile, &enabled)) || enabled != VARIANT_TRUE)
      return {false, "firewall-disabled"};
  }
  NET_FW_MODIFY_STATE modify = NET_FW_MODIFY_STATE_GP_OVERRIDE;
  long currentProfiles = 0;
  if (policy->get_LocalPolicyModifyState(&modify) != S_OK || modify != NET_FW_MODIFY_STATE_OK ||
      FAILED(policy->get_CurrentProfileTypes(&currentProfiles)) ||
      (currentProfiles & 7) == 0 || (currentProfiles & ~7) != 0)
    return {false, "firewall-policy-ineffective"};
  DWORD sidBytes = 0, domainChars = 0;
  SID_NAME_USE kind{};
  LookupAccountNameW(nullptr, L"CodexSandboxOffline", nullptr, &sidBytes, nullptr, &domainChars, &kind);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || sidBytes == 0 || sidBytes > SECURITY_MAX_SID_SIZE || domainChars > 32768)
    return {false, "offline-account-unavailable"};
  std::vector<unsigned char> sid(sidBytes);
  std::vector<wchar_t> domain(domainChars);
  if (!LookupAccountNameW(nullptr, L"CodexSandboxOffline", sid.data(), &sidBytes,
      domain.data(), &domainChars, &kind) || kind != SidTypeUser || !IsValidSid(sid.data()))
    return {false, "offline-account-unavailable"};
  ComPtr<INetFwRules> rules;
  if (FAILED(policy->get_Rules(rules.put()))) return {false, "network-policy-query-failed"};
  const wchar_t* nonLoopback = L"0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff";
  const wchar_t* loopback = L"127.0.0.0/8,::/127";
  if (!offlineRule(rules.operator->(), L"codex_sandbox_offline_block_outbound", NET_FW_RULE_DIR_OUT, 256, nonLoopback, sid.data()) ||
      !offlineRule(rules.operator->(), L"codex_sandbox_offline_block_inbound", NET_FW_RULE_DIR_IN, 256, nonLoopback, sid.data()) ||
      !offlineRule(rules.operator->(), L"codex_sandbox_offline_block_loopback_tcp", NET_FW_RULE_DIR_OUT, 6, loopback, sid.data()) ||
      !offlineRule(rules.operator->(), L"codex_sandbox_offline_block_loopback_udp", NET_FW_RULE_DIR_OUT, 17, loopback, sid.data()))
    return {false, "offline-rules-missing-or-mismatched"};
  return {true, "official-rules-ready"};
}

class Handle {
 public:
  explicit Handle(HANDLE value = nullptr) : value_(value) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
  bool valid() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
  void reset(HANDLE value = nullptr) {
    if (valid()) CloseHandle(value_);
    value_ = value;
  }
 private:
  HANDLE value_;
};

struct Host {
  HANDLE output;
  HANDLE input;
  HANDLE job;
  std::mutex outputMutex;
  std::atomic<bool> stopped{false};
  std::atomic<bool> closingControl{false};
  std::atomic<bool> outputFailed{false};
  std::atomic<bool> readerFailed{false};
};

bool writeFrame(Host& host, const std::string& json) {
  std::lock_guard<std::mutex> lock(host.outputMutex);
  const std::string line = json + "\n";
  size_t offset = 0;
  while (offset < line.size()) {
    DWORD written = 0;
    if (!WriteFile(host.output, line.data() + offset,
                   static_cast<DWORD>(line.size() - offset), &written, nullptr) ||
        written == 0) {
      host.outputFailed = true;
      host.stopped = true;
      if (host.job) TerminateJobObject(host.job, 125);
      return false;
    }
    offset += written;
  }
  return true;
}

std::string base64(const unsigned char* bytes, size_t size) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  result.reserve(((size + 2) / 3) * 4);
  for (size_t i = 0; i < size; i += 3) {
    uint32_t bits = static_cast<uint32_t>(bytes[i]) << 16;
    if (i + 1 < size) bits |= static_cast<uint32_t>(bytes[i + 1]) << 8;
    if (i + 2 < size) bits |= bytes[i + 2];
    result += alphabet[(bits >> 18) & 63];
    result += alphabet[(bits >> 12) & 63];
    result += i + 1 < size ? alphabet[(bits >> 6) & 63] : '=';
    result += i + 2 < size ? alphabet[bits & 63] : '=';
  }
  return result;
}

std::wstring quoteArgument(const std::wstring& argument) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t ch : argument) {
    if (ch == L'\\') { ++backslashes; continue; }
    result.append(ch == L'\"' ? backslashes * 2 + 1 : backslashes, L'\\');
    result += ch;
    backslashes = 0;
  }
  result.append(backslashes * 2, L'\\');
  result += L'\"';
  return result;
}

bool treeExited(HANDLE job, DWORD timeoutMs = 3000) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  do {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                  &info, sizeof(info), nullptr)) return false;
    if (info.ActiveProcesses == 0) return true;
    Sleep(20);
  } while (GetTickCount64() < deadline);
  return false;
}

int reportError(Host& host, const char* action, DWORD error, bool exited) {
  // Diagnostic text is generated by the host; no child text enters this frame.
  writeFrame(host, "{\"type\":\"error\",\"message\":\"" +
                       std::string(action) + " (Windows error " +
                       std::to_string(error) + ")\",\"treeExited\":" +
                       (exited ? "true}" : "false}"));
  return 1;
}

struct Reader {
  Host* host;
  HANDLE pipe;
  const char* stream;
};

DWORD WINAPI readOutput(LPVOID argument) {
  auto& reader = *static_cast<Reader*>(argument);
  unsigned char bytes[16384];
  while (true) {
    DWORD count = 0;
    if (!ReadFile(reader.pipe, bytes, sizeof(bytes), &count, nullptr)) {
      if (GetLastError() != ERROR_BROKEN_PIPE) reader.host->readerFailed = true;
      return 0;
    }
    if (count == 0) return 0;
    if (!writeFrame(*reader.host,
                    "{\"type\":\"output\",\"stream\":\"" +
                        std::string(reader.stream) + "\",\"data\":\"" +
                        base64(bytes, count) + "\"}")) return 0;
  }
}

DWORD WINAPI readControl(LPVOID argument) {
  auto& host = *static_cast<Host*>(argument);
  std::string line;
  char ch;
  DWORD count = 0;
  while (!host.closingControl) {
    if (!ReadFile(host.input, &ch, 1, &count, nullptr) || count == 0) {
      if (!host.closingControl) {
        host.stopped = true;
        TerminateJobObject(host.job, 125);
      }
      return 0;
    }
    if (ch == '\n') {
      if (line == "stop" || line == "stop\r") {
        host.stopped = true;
        TerminateJobObject(host.job, 125);
        return 0;
      }
      line.clear();
    } else if (line.size() < 128) {
      line += ch;
    }
  }
  return 0;
}

bool joinThread(HANDLE thread, DWORD waitMs, bool cancel) {
  if (!thread) return true;
  if (WaitForSingleObject(thread, waitMs) == WAIT_OBJECT_0) return true;
  if (!cancel) return false;
  // Repeat cancellation to cover a thread entering ReadFile concurrently.
  for (int attempt = 0; attempt < 20; ++attempt) {
    CancelSynchronousIo(thread);
    if (WaitForSingleObject(thread, 50) == WAIT_OBJECT_0) return true;
  }
  return false;
}

bool absolutePath(const std::wstring& value) {
  return (value.size() >= 3 && value[1] == L':' &&
          (value[2] == L'\\' || value[2] == L'/')) ||
         (value.size() >= 2 && value[0] == L'\\' && value[1] == L'\\');
}

int run(int argc, wchar_t** argv, Host& host) {
  const bool requireNetwork = argc > 5 && std::wstring(argv[5]) == L"--require-offline-network";
  const int separator = requireNetwork ? 6 : 5;
  const int programIndex = separator + 1;
  if (argc < 7 || std::wstring(argv[1]) != L"--cwd" ||
      std::wstring(argv[3]) != L"--timeout-ms" || argc <= programIndex ||
      std::wstring(argv[separator]) != L"--" ||
      !absolutePath(argv[2]) || !absolutePath(argv[programIndex])) {
    return reportError(host, "Invalid command-host arguments", ERROR_INVALID_PARAMETER, true);
  }
  wchar_t* end = nullptr;
  errno = 0;
  const unsigned long timeout = wcstoul(argv[4], &end, 10);
  if (errno || !*argv[4] || *end || argv[4][0] == L'-' || timeout == 0 ||
      timeout > 86400000UL) {
    return reportError(host, "Invalid timeout", ERROR_INVALID_PARAMETER, true);
  }
  // COM rules alone failed real loopback probes. The mandatory network gate
  // remains closed until the native WFP boundary is independently verified.
  if (requireNetwork) {
    return reportError(host, "Official offline network isolation unavailable", ERROR_ACCESS_DENIED, true);
  }
  std::wstring command;
  for (int i = programIndex; i < argc; ++i) {
    if (i > programIndex) command += L' ';
    command += quoteArgument(argv[i]);
  }
  if (command.size() >= 32767) {
    return reportError(host, "Command line exceeds Windows limit", ERROR_INVALID_PARAMETER, true);
  }

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.valid()) return reportError(host, "CreateJobObject", GetLastError(), true);
  host.job = job.get();
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    return reportError(host, "SetInformationJobObject", GetLastError(), true);
  }

  SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
  HANDLE stdoutReadRaw = nullptr, stdoutWriteRaw = nullptr;
  if (!CreatePipe(&stdoutReadRaw, &stdoutWriteRaw, &inherit, 0)) {
    return reportError(host, "Create stdout pipe", GetLastError(), true);
  }
  Handle stdoutRead(stdoutReadRaw), stdoutWrite(stdoutWriteRaw);
  HANDLE stderrReadRaw = nullptr, stderrWriteRaw = nullptr;
  if (!CreatePipe(&stderrReadRaw, &stderrWriteRaw, &inherit, 0)) {
    return reportError(host, "Create stderr pipe", GetLastError(), true);
  }
  Handle stderrRead(stderrReadRaw), stderrWrite(stderrWriteRaw);
  if (!SetHandleInformation(stdoutRead.get(), HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(stderrRead.get(), HANDLE_FLAG_INHERIT, 0)) {
    return reportError(host, "Protect output readers", GetLastError(), true);
  }
  Handle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &inherit, OPEN_EXISTING, 0, nullptr));
  if (!nullInput.valid()) return reportError(host, "Open NUL stdin", GetLastError(), true);

  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeSize);
  std::vector<unsigned char> attributes(attributeSize);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(list, 2, 0, &attributeSize)) {
    return reportError(host, "Initialize process attributes", GetLastError(), true);
  }
  HANDLE inherited[] = {nullInput.get(), stdoutWrite.get(), stderrWrite.get()};
  HANDLE jobHandle = job.get();
  const bool attributesValid =
      UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobHandle,
                                sizeof(jobHandle), nullptr, nullptr) &&
      UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                sizeof(inherited), nullptr, nullptr);
  if (!attributesValid) {
    DWORD error = GetLastError();
    DeleteProcThreadAttributeList(list);
    return reportError(host, "Bind job and inherited handles", error, true);
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nullInput.get();
  startup.StartupInfo.hStdOutput = stdoutWrite.get();
  startup.StartupInfo.hStdError = stderrWrite.get();
  startup.lpAttributeList = list;
  PROCESS_INFORMATION info{};
  // The main process supplies a sanitized environment when it starts this host.
  BOOL created = CreateProcessW(argv[programIndex], command.data(), nullptr, nullptr, TRUE,
                                 EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED |
                                     CREATE_NO_WINDOW,
                                 nullptr, argv[2], &startup.StartupInfo, &info);
  DWORD creationError = created ? 0 : GetLastError();
  DeleteProcThreadAttributeList(list);
  stdoutWrite.reset();
  stderrWrite.reset();
  nullInput.reset();
  if (!created) return reportError(host, "Create contained process", creationError, treeExited(job.get()));
  Handle process(info.hProcess), primaryThread(info.hThread);
  Reader stdoutReader{&host, stdoutRead.get(), "stdout"};
  Reader stderrReader{&host, stderrRead.get(), "stderr"};
  DWORD launchError = 0;
  const char* launchAction = "Create command-host threads";
  Handle stdoutThread(CreateThread(nullptr, 0, readOutput, &stdoutReader, 0, nullptr));
  if (!stdoutThread.valid()) launchError = GetLastError();
  Handle stderrThread(CreateThread(nullptr, 0, readOutput, &stderrReader, 0, nullptr));
  if (!stderrThread.valid() && launchError == 0) launchError = GetLastError();
  Handle controlThread(CreateThread(nullptr, 0, readControl, &host, 0, nullptr));
  if (!controlThread.valid() && launchError == 0) launchError = GetLastError();
  if (launchError == 0 && !writeFrame(host, "{\"type\":\"started\",\"pid\":" +
                               std::to_string(info.dwProcessId) + "}")) {
    launchError = ERROR_BROKEN_PIPE;
    launchAction = "Write started frame";
  } else if (launchError == 0 && !host.stopped &&
             ResumeThread(primaryThread.get()) == static_cast<DWORD>(-1) && !host.stopped) {
    launchError = GetLastError();
    launchAction = "Resume contained process";
  }
  primaryThread.reset();

  DWORD exitCode = 1;
  DWORD waitError = 0;
  if (launchError == 0) {
    DWORD waited = WaitForSingleObject(process.get(), static_cast<DWORD>(timeout));
    if (waited == WAIT_TIMEOUT) {
      host.stopped = true;
      TerminateJobObject(job.get(), 124);
    } else if (waited != WAIT_OBJECT_0) {
      waitError = GetLastError();
    }
  }
  if (!GetExitCodeProcess(process.get(), &exitCode)) waitError = GetLastError();
  // Root exit also ends background descendants. No breakaway flag is granted.
  if (!TerminateJobObject(job.get(), launchError ? 126 :
                          (exitCode == STILL_ACTIVE ? (host.stopped ? 125 : 126) : exitCode))) {
    waitError = GetLastError();
  }
  const bool exited = treeExited(job.get());
  if (WaitForSingleObject(process.get(), 1000) == WAIT_OBJECT_0) {
    if (!GetExitCodeProcess(process.get(), &exitCode)) waitError = GetLastError();
  } else {
    waitError = ERROR_TIMEOUT;
  }
  host.closingControl = true;
  const bool controlJoined = joinThread(controlThread.get(), 0, true);
  const bool stdoutJoined = joinThread(stdoutThread.get(), 1000, true);
  const bool stderrJoined = joinThread(stderrThread.get(), 1000, true);
  if (!controlJoined || !stdoutJoined || !stderrJoined) {
    reportError(host, "Command-host thread shutdown unconfirmed", ERROR_TIMEOUT, exited);
    // No stack-owned thread context may outlive this function.
    ExitProcess(1);
  }
  if (launchError) return reportError(host, launchAction, launchError, exited);
  if (waitError) return reportError(host, "Process wait or job termination", waitError, exited);
  if (host.readerFailed) return reportError(host, "Command output drain interrupted", ERROR_OPERATION_ABORTED, exited);
  if (host.outputFailed) return 1;
  writeFrame(host, "{\"type\":\"closed\",\"exitCode\":" + std::to_string(exitCode) +
                       ",\"treeExited\":" + (exited ? "true" : "false") +
                       ",\"stopped\":" + (host.stopped ? "true}" : "false}"));
  return host.outputFailed ? 1 : 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  Host host{GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_INPUT_HANDLE), nullptr};
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--capabilities") {
      return writeFrame(host, "{\"protocol\":1,\"atomicJob\":true}") ? 0 : 1;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--network-capability") {
      const auto network = offlineNetworkRules();
      return writeFrame(host, std::string("{\"protocol\":1,\"offlineNetwork\":false,\"rulesReady\":") +
          (network.available ? "true" : "false") +
          ",\"reason\":\"official-loopback-boundary-unverified\"}") ? 0 : 1;
    }
    return run(argc, argv, host);
  } catch (...) {
    // Any job handle owned by run has closed and requested kernel termination.
    host.job = nullptr;
    return reportError(host, "Unexpected command-host failure", ERROR_UNHANDLED_EXCEPTION, false);
  }
}
