import FinClawMacCore
import SwiftUI

/// 말풍선 (plan §4-3 B1~B6). 값 + 클로저만 받는다 (D3).
struct BubbleView: View {
  let bubble: Bubble
  let running: Bool
  let toolLabel: String?
  var onAbort: () -> Void = {}
  var onMore: () -> Void = {}
  @State private var lingering: String?  // 도구 문구 최소 유지 0.4s

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      switch bubble {
      case .answer(let text, _):
        if !text.isEmpty { Clamped(text: text, onMore: onMore) }
        if let label = toolLabel ?? lingering { Text(label).font(.callout).foregroundStyle(.secondary).help(label) }
        if running { Button("중지", action: onAbort).keyboardShortcut(".", modifiers: .command).buttonStyle(Pill()) }
      case .proactive(let p, _):
        HStack(spacing: 4) {
          Text(p.title).bold()
          if p.count >= 2 { Text("×\(p.count)").foregroundStyle(.secondary) }
        }
        Clamped(text: p.body, onMore: onMore)
      case .notice(let text, _), .error(let text, _): Clamped(text: text, onMore: onMore)
      }
    }
    .foregroundStyle(.primary)
    .padding(10)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
    .task(id: toolLabel) {
      if toolLabel != nil { lingering = toolLabel } else { try? await Task.sleep(for: .seconds(0.4)); lingering = nil }
    }
  }
}

/// B1·B3: 폭 300pt 로 줄바꿈, 6줄이 넘으면 앞 6줄 + 24pt 페이드 + "자세히 ▸". 마크다운은 인라인만.
struct Clamped: View {
  let text: String
  let onMore: () -> Void

  var body: some View {
    let md =
      (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
    SixLines {
      Text("가").lineLimit(6, reservesSpace: true).hidden()  // 6줄 높이 기준
      ViewThatFits(in: .vertical) {
        Text(md)
        VStack(alignment: .leading, spacing: 2) {
          Text(md).lineLimit(6).mask(
            LinearGradient(
              stops: [.init(color: .black, location: 0.75), .init(color: .clear, location: 1)], startPoint: .top,
              endPoint: .bottom))
          Button("자세히 ▸", action: onMore).buttonStyle(.plain).foregroundStyle(.tint)
        }
        .fixedSize(horizontal: false, vertical: true)  // 제안 높이(6줄)에 눌려 5줄로 줄지 않게
      }
    }
  }
}

/// 첫 subview(숨긴 6줄 기준)의 높이를 둘째(ViewThatFits)에 높이 제안으로 준다. 폭은 최대 300.
/// 부모가 크기를 제안하지 않아도(fixedSize 루트·ImageRenderer) 줄바꿈과 6줄 판정이 성립한다.
struct SixLines: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    subviews[1].sizeThatFits(offer(proposal, subviews))
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let o = offer(proposal, subviews)
    for v in subviews { v.place(at: bounds.origin, proposal: o) }
  }
  private func offer(_ p: ProposedViewSize, _ s: Subviews) -> ProposedViewSize {
    let w = min(p.width ?? 300, 300)
    return ProposedViewSize(width: w, height: s[0].sizeThatFits(ProposedViewSize(width: w, height: nil)).height + 1)
  }
}

/// SwiftUI 가 직접 그리는 버튼 (말풍선 위에서 가볍고, 스냅샷에도 그대로 나온다).
struct Pill: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.callout).padding(.horizontal, 9).padding(.vertical, 3)
      .background(Capsule().fill(.primary.opacity(configuration.isPressed ? 0.2 : 0.1)))
  }
}

/// B8 입력창. Enter = 전송 후 포커스 해제, Esc = 닫기. run 중 비활성 (D4).
struct InputBar: View {
  @Binding var text: String
  let disabled: Bool
  let onSubmit: () -> Void
  let onCancel: () -> Void
  let onExpand: () -> Void
  let onFocus: (Bool) -> Void
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 6) {
      TextField(Copy.inputPlaceholder, text: $text).textFieldStyle(.plain).focused($focused).disabled(disabled)
        .onSubmit { onSubmit(); focused = false }
        .onExitCommand { focused = false; onCancel() }
      Button("▸", action: onExpand).buttonStyle(.plain).help("대화 펼치기")
    }
    .padding(8)
    .frame(width: 260)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    .onAppear { focused = true }
    .onChange(of: focused) { onFocus($1) }
  }
}
