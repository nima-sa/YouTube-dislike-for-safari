import Cocoa
import SafariServices
import WebKit

private let extensionBundleIdentifier = "page.malina.youtube-dislike.macos.extension"

final class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    @IBOutlet private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        guard let page = Bundle.main.url(forResource: "Main", withExtension: "html"),
              let resources = Bundle.main.resourceURL else { return }
        webView.loadFileURL(page, allowingReadAccessTo: resources)
    }

    private func deliver(_ payload: [String: Any]) {
        webView.callAsyncJavaScript("window.receiveNative(payload)", arguments: ["payload": payload], in: nil, in: .page) { _ in }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let info = Bundle.main.infoDictionary ?? [:]
        deliver(["type": "app", "version": info["CFBundleShortVersionString"] as? String ?? "—",
                 "build": info["CFBundleVersion"] as? String ?? "—"])
        if let identity = BuildIdentity(info: info) {
            deliver(["type": "ci", "label": identity.label, "url": identity.url.absoluteString])
        }
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { [weak self] state, error in
            DispatchQueue.main.async {
                self?.deliver(["type": "extension", "enabled": state?.isEnabled as Any? ?? NSNull()])
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated,
           (url.scheme == "mailto" || (url.scheme == "https" && (url.host == "returnyoutubedislike.com" || url == BuildIdentity(info: Bundle.main.infoDictionary ?? [:])?.url))) {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any], let command = body["type"] as? String else { return }
        if command == "open-preferences" {
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { [weak self] error in
                DispatchQueue.main.async {
                    if error != nil { self?.deliver(["type": "settings-error"]) }
                }
            }
        }
    }
}
