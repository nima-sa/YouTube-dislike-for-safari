import SwiftUI

@main
struct YouTubeDislikeApp: App {
    var body: some Scene { WindowGroup { SetupView() } }
}

private struct SetupView: View {
    private var ru: Bool { Locale.preferredLanguages.first?.hasPrefix("ru") == true }
    private func text(_ russian: String, _ english: String) -> String { ru ? russian : english }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 12) {
                    Image(systemName: "hand.thumbsdown.fill").font(.title2).foregroundStyle(.red)
                        .frame(width: 52, height: 52).background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 16))
                    Text("YouTube Dislike").font(.title2.bold())
                }
                Text(text("Дизлайки снова видны", "See dislikes again"))
                    .font(.largeTitle.bold())
                VStack(alignment: .leading, spacing: 22) {
                    feature("square.and.arrow.up", text("Поделиться видео", "Share a video"),
                            text("В YouTube или Safari: Поделиться → Ещё → YouTube Dislike.", "In YouTube or Safari: Share → More → YouTube Dislike."))
                    Divider()
                    feature("safari", text("Прямо в Safari", "Right in Safari"),
                            text("Включите расширение — оценка появится в кнопке дизлайка.", "Enable the extension to see the estimate in the dislike button."))
                    DisclosureGroup(text("Как включить", "Set up Safari")) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(text("1. Настройки → Приложения → Safari → Расширения. На iOS 16–17: Настройки → Safari.", "1. Settings → Apps → Safari → Extensions. On iOS 16–17: Settings → Safari."))
                            Text(text("2. Включите YouTube Dislike и разрешите доступ к YouTube и API RYD.", "2. Enable YouTube Dislike and allow YouTube and RYD API access."))
                            Text(text("3. Откройте видео в Safari.", "3. Open a video in Safari."))
                        }.font(.subheadline).foregroundStyle(.secondary).padding(.top, 12)
                    }
                }.padding(22).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
                Text(text("≈ — оценка по данным Return YouTube Dislike.", "≈ is an estimate from Return YouTube Dislike."))
                    .font(.footnote).foregroundStyle(.secondary)
                DisclosureGroup(text("Голоса и приватность", "Votes & privacy")) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(text("Отправка новых голосов включена. Выключатель — в настройках расширения Safari. Через «Поделиться» голоса не отправляются.", "New vote submission is on. Change it in the Safari extension settings. Sharing a link never submits a vote."))
                        Text(text("Для статистики отправляется ID видео. Для голосования — также случайный ID установки, голос и данные проверки. Без cookies и referrer. RYD видит IP-адрес.", "Statistics share the video ID. Voting also shares a random installation ID, vote and challenge data. No cookies or referrer. RYD sees your IP address."))
                        Link(text("О Return YouTube Dislike ↗", "About Return YouTube Dislike ↗"), destination: URL(string: "https://returnyoutubedislike.com/")!)
                    }.font(.footnote).foregroundStyle(.secondary).padding(.top, 12)
                }.font(.subheadline)
                VStack(alignment: .leading, spacing: 14) {
                    if let url = feedbackURL {
                        Link(destination: url) {
                            HStack {
                                Text(text("Отправить отзыв", "Send feedback"))
                                Spacer()
                                Image(systemName: "envelope")
                            }.padding(20)
                        }
                        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                    }
                    HStack {
                        Text(appVersion)
                        if let identity = BuildIdentity(info: Bundle.main.infoDictionary ?? [:]) {
                            Link(identity.label, destination: identity.url)
                        }
                    }.font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 4)
                }
            }.padding(24).frame(maxWidth: 580).frame(maxWidth: .infinity)
        }.background(Color(uiColor: .systemGroupedBackground)).tint(.red)
    }
    private var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return "v\(info["CFBundleShortVersionString"] as? String ?? "—") (\(info["CFBundleVersion"] as? String ?? "—"))"
    }
    private var feedbackURL: URL? {
        var url = URLComponents()
        url.scheme = "mailto"
        url.path = "denis@malina.page"
        url.queryItems = [
            URLQueryItem(name: "subject", value: "YouTube Dislike — " + text("Отзыв", "Feedback")),
            URLQueryItem(name: "body", value: "\n\nYouTube Dislike \(appVersion) · iOS/iPadOS")
        ]
        return url.url
    }
    private func feature(_ icon: String, _ title: String, _ subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).font(.title2).foregroundStyle(.red).frame(width: 28)
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
