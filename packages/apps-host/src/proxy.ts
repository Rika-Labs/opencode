import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge"

export function contentSecurityPolicy(csp: McpUiResourceCsp | undefined): string | undefined {
  if (!csp) return undefined
  const join = (domains: string[] | undefined) => (domains ?? []).join(" ")
  const parts = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${join(csp.resourceDomains)}`.trim(),
    `connect-src ${join(csp.connectDomains)}`.trim(),
    `img-src data: blob: ${join(csp.resourceDomains)}`.trim(),
    `style-src 'unsafe-inline' ${join(csp.resourceDomains)}`.trim(),
    `font-src ${join(csp.resourceDomains)}`.trim(),
    `media-src ${join(csp.resourceDomains)}`.trim(),
    `frame-src ${csp.frameDomains?.length ? join(csp.frameDomains) : "'none'"}`,
    `base-uri ${csp.baseUriDomains?.length ? join(csp.baseUriDomains) : "'self'"}`,
  ]
  return parts.join("; ")
}

export function proxyHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>opencode app sandbox</title>
<style>html,body{margin:0;height:100%;width:100%;background:transparent}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<script>
(function () {
  if (window.self === window.top) return
  var hostOrigin = null
  try {
    if (document.referrer) hostOrigin = new URL(document.referrer).origin
  } catch (e) {}
  var ownOrigin = new URL(window.location.href).origin
  var inner = document.createElement("iframe")
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms")
  document.body.appendChild(inner)
  var permissions = { camera: "camera", microphone: "microphone", geolocation: "geolocation", clipboardWrite: "clipboard-write" }
  function allowAttribute(granted) {
    if (!granted) return ""
    return Object.keys(permissions).filter(function (key) { return granted[key] !== undefined }).map(function (key) { return permissions[key] }).join("; ")
  }
  function cspMeta(csp) {
    if (!csp) return ""
    var join = function (domains) { return (domains || []).join(" ") }
    var value = [
      "default-src 'none'",
      "script-src 'unsafe-inline' " + join(csp.resourceDomains),
      "connect-src " + join(csp.connectDomains),
      "img-src data: blob: " + join(csp.resourceDomains),
      "style-src 'unsafe-inline' " + join(csp.resourceDomains),
      "font-src " + join(csp.resourceDomains),
      "media-src " + join(csp.resourceDomains),
      "frame-src " + (csp.frameDomains && csp.frameDomains.length ? join(csp.frameDomains) : "'none'"),
      "base-uri " + (csp.baseUriDomains && csp.baseUriDomains.length ? join(csp.baseUriDomains) : "'self'"),
    ].join("; ")
    return '<meta http-equiv="Content-Security-Policy" content="' + value.replace(/"/g, "&quot;") + '">'
  }
  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (hostOrigin && event.origin !== hostOrigin) return
      var data = event.data
      if (data && data.method === "ui/notifications/sandbox-resource-ready" && data.params) {
        var params = data.params
        if (typeof params.sandbox === "string") inner.setAttribute("sandbox", params.sandbox)
        var allow = allowAttribute(params.permissions)
        if (allow) inner.setAttribute("allow", allow)
        if (typeof params.html === "string") {
          var doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document)
          if (doc) {
            doc.open()
            doc.write(cspMeta(params.csp) + params.html)
            doc.close()
          } else {
            inner.srcdoc = cspMeta(params.csp) + params.html
          }
        }
        return
      }
      if (inner.contentWindow) inner.contentWindow.postMessage(data, "*")
      return
    }
    if (event.source === inner.contentWindow) {
      if (event.origin !== ownOrigin) return
      window.parent.postMessage(event.data, hostOrigin || "*")
    }
  })
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, hostOrigin || "*")
})()
</script>
</body>
</html>`
}
