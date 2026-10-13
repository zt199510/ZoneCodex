/** Network diagnostics must never retain request-local credentials, including blocked errors. */
export function redactGitNetworkError(
  error: unknown,
  extraHeader?: string,
  credentialToken?: string
): string {
  let message = error instanceof Error ? error.message : '远程操作失败'
  const secrets = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, extraHeader, credentialToken]
  if (extraHeader?.startsWith('Authorization: Basic ')) {
    const encoded = extraHeader.slice('Authorization: Basic '.length)
    secrets.push(encoded, 'Basic ' + encoded)
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    secrets.push(decoded, decoded.slice(decoded.indexOf(':') + 1))
  }
  for (const secret of secrets
    .filter((value): value is string => !!value)
    .sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[凭据已隐藏]')
  return message
    .replace(/https:\/\/[^\s]*@/g, 'https://[凭据已隐藏]@')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 800)
}
