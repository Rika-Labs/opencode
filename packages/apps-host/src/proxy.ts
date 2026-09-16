import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge"

export function contentSecurityPolicy(csp: McpUiResourceCsp | undefined): string {
  const clean = (domains: unknown) =>
    (Array.isArray(domains) ? domains : [])
      .map((domain) => String(domain).replace(/[\s;'"]/g, ""))
      .filter((domain) => domain.length > 0)
  const resource = clean(csp?.resourceDomains).join(" ")
  const connect = clean(csp?.connectDomains)
  const frame = clean(csp?.frameDomains)
  const base = clean(csp?.baseUriDomains)
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resource}`.trim(),
    `connect-src ${connect.length ? connect.join(" ") : "'none'"}`,
    `img-src data: blob: ${resource}`.trim(),
    `style-src 'unsafe-inline' ${resource}`.trim(),
    `font-src ${resource.length ? resource : "'none'"}`,
    `media-src ${resource.length ? resource : "'none'"}`,
    `frame-src ${frame.length ? frame.join(" ") : "'none'"}`,
    `base-uri ${base.length ? base.join(" ") : "'self'"}`,
    "form-action 'none'",
  ].join("; ")
}

export function proxyHtml(hostOrigin?: string): string {
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
  var hostOrigin = ${JSON.stringify(hostOrigin ?? "")} || new URL(window.location.href).searchParams.get("host")
  var ownOrigin = new URL(window.location.href).origin
  var inner = document.createElement("iframe")
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms")
  document.body.appendChild(inner)
  var permissions = { camera: "camera", microphone: "microphone", geolocation: "geolocation", clipboardWrite: "clipboard-write" }
  function allowAttribute(granted) {
    if (!granted) return ""
    return Object.keys(permissions).filter(function (key) { return granted[key] !== undefined && granted[key] !== false }).map(function (key) { return permissions[key] }).join("; ")
  }
  function cspMeta(csp) {
    var clean = function (domains) {
      return (Array.isArray(domains) ? domains : []).map(function (domain) { return String(domain).replace(/[\\s;'"]/g, "") }).filter(function (domain) { return domain.length > 0 })
    }
    var resource = clean(csp && csp.resourceDomains).join(" ")
    var connect = clean(csp && csp.connectDomains)
    var frame = clean(csp && csp.frameDomains)
    var base = clean(csp && csp.baseUriDomains)
    var value = [
      "default-src 'none'",
      ("script-src 'unsafe-inline' " + resource).trim(),
      "connect-src " + (connect.length ? connect.join(" ") : "'none'"),
      ("img-src data: blob: " + resource).trim(),
      ("style-src 'unsafe-inline' " + resource).trim(),
      "font-src " + (resource.length ? resource : "'none'"),
      "media-src " + (resource.length ? resource : "'none'"),
      "frame-src " + (frame.length ? frame.join(" ") : "'none'"),
      "base-uri " + (base.length ? base.join(" ") : "'self'"),
      "form-action 'none'",
    ].join("; ")
    return '<meta http-equiv="Content-Security-Policy" content="' + value.replace(/"/g, "&quot;") + '">'
  }
  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (!hostOrigin || event.origin !== hostOrigin) return
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
      var method = event.data && event.data.method
      if (typeof method === "string" && method.indexOf("ui/notifications/sandbox-") === 0) return
      window.parent.postMessage(event.data, hostOrigin || "*")
    }
  })
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, hostOrigin || "*")
})()
</script>
</body>
</html>`
}
