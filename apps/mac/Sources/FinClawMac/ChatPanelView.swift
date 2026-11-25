import SwiftUI

struct HistoryLine: Decodable, Hashable { let role: String; let text: String }  // 서버 {role,text} 그대로
enum PanelTab: Hashable { case chat, alerts }

/// 펼친 패널 340×460 (§4-5). 대화 = chat.history + 진행 중 run, 알림 = 폼. 브리핑 상세(U2)는 같은 자리에 전문.
struct ChatPanelView: View {
  let history: [HistoryLine], streaming: String?, detail: String?
  @Binding var tab: PanelTab
  let onCollapse: () -> Void, onCloseDetail: () -> Void, alerts: AlertFormView
  var scrolls = true  // 스냅샷: ImageRenderer 는 ScrollView 를 그리지 않는다

  var body: some View {
    let lines = history + (streaming.map { [HistoryLine(role: "assistant", text: $0)] } ?? [])
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        ForEach([(PanelTab.chat, "대화"), (.alerts, "알림")], id: \.0) { t in
          Button(t.1) { tab = t.0 }.buttonStyle(Pill(on: tab == t.0))
        }
        Spacer()
        Button(detail == nil ? "접기" : "닫기", action: detail == nil ? onCollapse : onCloseDetail).buttonStyle(Pill())
      }
      if let detail {
        ScrollView { Text(detail).font(.body.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
      } else if tab == .alerts {
        alerts
        Spacer(minLength: 0)
      } else {
        let list = VStack(spacing: 8) {
          ForEach(Array(lines.enumerated()), id: \.offset) { i, l in
            Text(inlineMarkdown(l.text)).textSelection(.enabled).padding(8)
              .background(.primary.opacity(l.role == "user" ? 0.1 : 0.04), in: RoundedRectangle(cornerRadius: 8))
              .frame(maxWidth: .infinity, alignment: l.role == "user" ? .trailing : .leading).id(i)
          }
        }
        if scrolls {
          ScrollViewReader { proxy in
            ScrollView { list }
              .onAppear { proxy.scrollTo(lines.count - 1, anchor: .bottom) }
              .onChange(of: lines) { proxy.scrollTo($1.count - 1, anchor: .bottom) }
          }
        } else {
          list
          Spacer(minLength: 0)
        }
      }
    }
    .padding(12)
    .frame(width: 340, height: 460)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
  }
}
