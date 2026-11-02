import UIKit
import SwiftUI
import UniformTypeIdentifiers

private func localized(_ ru: String, _ en: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("ru") == true ? ru : en
}

@MainActor
final class ShareViewController: UIViewController {
    private var task: Task<Void, Never>?
    private let model = ShareModel()

    private func finish() {
        task?.cancel()
        model.cancel()
        extensionContext?.completeRequest(returningItems: nil)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareResultView(model: model, close: { [weak self] in
            self?.finish()
        }))
        view.backgroundColor = .systemBackground
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
        preferredContentSize = CGSize(width: 420, height: 380)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
                var ids = Set<String>()
                for provider in items.flatMap({ $0.attachments ?? [] }).prefix(8) {
                    let type = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? UTType.url.identifier : UTType.plainText.identifier
                    guard provider.hasItemConformingToTypeIdentifier(type) else { continue }
                    let value = try await provider.loadItem(forTypeIdentifier: type)
                    try Task.checkCancellation()
                    let text = (value as? URL)?.absoluteString ?? (value as? String)
                    if let text, let id = SharedVideo.id(in: text) { ids.insert(id) }
                }
                guard ids.count == 1, let id = ids.first else {
                    model.error = localized("Отправьте ссылку на одно видео YouTube.", "Share a link to one YouTube video.")
                    model.loading = false
                    return
                }
                model.videoID = id
                await model.load()
            } catch {
                guard !Task.isCancelled else { return }
                model.error = localized("Не удалось прочитать ссылку. Попробуйте поделиться ей ещё раз.", "Could not read the link. Try sharing it again.")
                model.loading = false
            }
        }
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Configure the existing presentation only. Never present a second sheet
        // inside the remote Share Extension container.
        let compact = UISheetPresentationController.Detent.Identifier("statistics")
        let controller = navigationController ?? self
        controller.preferredContentSize = preferredContentSize
        if let sheet = controller.sheetPresentationController {
            sheet.detents = [
                .custom(identifier: compact) { context in min(380, context.maximumDetentValue) },
                .large()
            ]
            sheet.selectedDetentIdentifier = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .large : compact
            sheet.prefersGrabberVisible = true
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        task?.cancel()
        model.cancel()
    }

}

@MainActor
private final class ShareModel: ObservableObject {
    @Published var videoID: String?
    @Published var statistics: VideoStatistics?
    @Published var loading = true
    @Published var error: String?
    private var retryTask: Task<Void, Never>?
    func retry() { retryTask?.cancel(); retryTask = Task { await load() } }
    func cancel() { retryTask?.cancel() }
    func load() async {
        guard let videoID else { return }
        loading = true; error = nil
        do {
            let result = try await StatisticsClient.fetch(videoID: videoID)
            try Task.checkCancellation()
            statistics = result
        } catch {
            guard !Task.isCancelled else { return }
            self.error = localized("Статистика сейчас недоступна. Проверьте соединение и повторите.", "Statistics are unavailable. Check your connection and try again.")
        }
        loading = false
    }
}

private struct ShareResultView: View {
    @ObservedObject var model: ShareModel
    let close: () -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if model.loading {
                        ProgressView(localized("Получаем статистику…", "Loading statistics…"))
                            .frame(maxWidth: .infinity, minHeight: 170)
                    } else if let error = model.error {
                        Image(systemName: "wifi.exclamationmark").font(.largeTitle).foregroundStyle(.secondary)
                        Text(error).font(.title3)
                        if model.videoID != nil {
                            Button(localized("Повторить", "Try again")) { model.retry() }.buttonStyle(.borderedProminent)
                        }
                    } else if let stats = model.statistics {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) {
                                metric(title: localized("Лайки", "Likes"), value: stats.likes.formatted(), icon: "hand.thumbsup.fill", color: .primary)
                                metric(title: localized("Дизлайки", "Dislikes"), value: "≈ " + stats.dislikes.formatted(), icon: "hand.thumbsdown.fill", color: .red)
                            }
                            VStack(spacing: 12) {
                                metric(title: localized("Лайки", "Likes"), value: stats.likes.formatted(), icon: "hand.thumbsup.fill", color: .primary)
                                metric(title: localized("Дизлайки", "Dislikes"), value: "≈ " + stats.dislikes.formatted(), icon: "hand.thumbsdown.fill", color: .red)
                            }
                        }
                        Text(localized("≈ — оценка по данным RYD.", "≈ is an estimate from RYD."))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    DisclosureGroup(localized("Источник и данные", "Source & privacy")) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(localized("Передаётся ID видео. RYD видит IP-адрес. Голоса не отправляются.", "The video ID is shared. RYD sees your IP address. No votes are submitted."))
                            Link("Return YouTube Dislike ↗", destination: URL(string: "https://returnyoutubedislike.com/")!)
                        }.font(.footnote).foregroundStyle(.secondary).padding(.top, 8)
                    }.font(.footnote)

                }.padding(24).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
            }
            .navigationTitle("YouTube Dislike")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(action: close) {
                        Image(systemName: "xmark")
                    }
                    .tint(.primary)
                    .accessibilityLabel(localized("Закрыть", "Close"))
                }
            }
        }.tint(.red)
    }
    private func metric(title: String, value: String, icon: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: icon).font(.subheadline.weight(.semibold)).foregroundStyle(color)
            Text(value).font(.system(.title, design: .rounded, weight: .bold))
                .monospacedDigit().fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine)
    }

}
