import Foundation

@main struct Tests {
    static func main() {
        let valid: [String: Any] = ["CIRepository": "skar404/youtube-dislike-for-safari", "CICommit": String(repeating: "a", count: 40), "CIVersion": "2026.11.1", "CIBuild": "3", "CFBundleShortVersionString": "2026.11.1", "CFBundleVersion": "3", "CIRun": "123", "CIAttempt": "1"]
        precondition(BuildIdentity(info: valid)?.label == "CI · aaaaaaa")
        precondition(BuildIdentity(info: [:]) == nil)
        for (key, value) in [("CIRepository", "evil/example"), ("CICommit", "bad"), ("CIVersion", "1"), ("CIBuild", "4"), ("CIRun", "123/evil"), ("CIAttempt", "0")] {
            var info = valid; info[key] = value
            precondition(BuildIdentity(info: info) == nil)
        }
        print("Build identity validation passed")
    }
}
