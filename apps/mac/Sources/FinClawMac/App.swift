import AppKit
import FinClawMacCore
import SwiftUI

@main enum Entry {
  static func main() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--smoke"), i + 1 < args.count {
      let listen = args.firstIndex(of: "--listen").flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } ?? 0
      setvbuf(stdout, nil, _IOLBF, 0)  // 파이프로 볼 때 줄 단위 출력 (--listen 중 실시간 확인)
      Task { @MainActor in exit(await Smoke.run(question: args[i + 1], listen: listen)) }
      dispatchMain()
    }
    if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
      MainActor.assumeIsolated { Snapshot.run(to: URL(fileURLWithPath: args[i + 1], isDirectory: true)) }; exit(0)
    }
    MainActor.assumeIsolated { FinClawMacApp.main() }
  }
}

struct FinClawMacApp: App {
  @NSApplicationDelegateAdaptor(Delegate.self) var delegate

  var body: some Scene {
    let m = delegate.model
    MenuBarExtra("FinClaw", systemImage: m.state.mood == .offline ? "zzz" : "face.smiling") {  // Settings 씬 금지(macOS 26 빈 창)
      Button(m.hidden ? "캐릭터 보이기" : "캐릭터 숨기기") { m.toggleHidden() }
      Button("대화 새로 시작") { m.reset() }
      Toggle("먼저 말 걸기", isOn: Binding(get: { m.state.proactiveEnabled }, set: { m.setProactive($0) }))
      Button("재연결") { m.reconnect() }
      Divider()
      Button("종료") { NSApp.terminate(nil) }
    }
  }
}

@MainActor final class Delegate: NSObject, NSApplicationDelegate {
  let model = AppModel()

  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.accessory)
    let p = CharacterPanel(rootView: RootView(model: model))
    model.panel = p; p.orderFrontRegardless()
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
    ) { [weak p] _ in MainActor.assumeIsolated { p?.ensureOnScreen() } }
  }
}

/// 우하단 정렬: 말풍선 · 입력창 · 캐릭터. 내용 크기를 패널에 알린다 (M7-1).
struct RootView: View {
  @Bindable var model: AppModel

  var body: some View {
    let s = model.state
    VStack(alignment: .trailing, spacing: 6) {
      if model.expanded {
        let live: String? = if s.runId != nil, case .answer(let t, _)? = s.bubble { t } else { nil }
        ChatPanelView(
          history: model.history, streaming: live, detail: model.detail, tab: $model.tab, onCollapse: model.collapse,
          onCloseDetail: { model.detail = nil },
          alerts: AlertFormView(
            rows: model.alerts, error: model.alertError, onCreate: model.createAlert, onDelete: model.deleteAlert))
      } else if let b = s.bubble {
        BubbleView(
          bubble: b, running: s.runId != nil, toolLabel: s.toolLabel, onAbort: model.abort, onMore: model.more,
          onDeleteAlert: model.deleteShownAlert, onExplain: model.explain)
      }
      if model.inputOpen {
        InputBar(
          text: $model.input, disabled: s.runId != nil, onSubmit: model.send, onCancel: model.closeInput,
          onExpand: model.expand, onFocus: { model.apply(.inputFocused($0)) })
      }
      CharacterView(state: s, onTap: model.openInput, onBadge: { model.apply(.dismiss) })
    }
    .padding(6)
    .fixedSize()
    .onHover { model.hovering = $0 }
    .onChange(of: model.tab) { if $1 == .alerts { model.listAlerts() } }
    .onGeometryChange(for: CGSize.self) { $0.size } action: { model.panel?.fit($0) }
  }
}

/// D1 — 인자 도메인 덕에 `-gatewayURL`·`-tokenPath` 와 `defaults write` 둘 다 먹는다.
enum Settings {
  static var gatewayURL: URL {
    UserDefaults.standard.string(forKey: "gatewayURL").flatMap(URL.init(string:)) ?? URL(string: "ws://127.0.0.1:3000/")!
  }
  static var tokenURL: URL {
    let path = UserDefaults.standard.string(forKey: "tokenPath") ?? "~/.finclaw/gateway.token"
    return URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
  }
}
