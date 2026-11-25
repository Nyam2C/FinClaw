import FinClawMacCore
import SwiftUI

/// 알림 탭: 목록(행마다 2단계 삭제) + 만들기 폼. 요청 모델·조건 값은 Core `AlertCreate` (서버 enum 그대로).
struct AlertFormView: View {
  let rows: [AlertRow], error: String?, onCreate: (AlertCreate) -> Void, onDelete: (String) -> Void
  @State private var symbol = ""
  @State private var value = ""
  @State private var condition = "price_above"

  var body: some View {
    let news = condition == "news_match"
    let request = AlertCreate(symbol: symbol, condition: condition, value: value)
    VStack(alignment: .leading, spacing: 8) {
      ForEach(rows) { r in
        HStack {
          let value = r.keyword ?? r.threshold.map { String(format: "%g", $0) } ?? ""
          Text("\(r.symbol) \(Self.label(r.condition)) \(value)")
          Spacer()
          TwoStepButton(title: "삭제") { onDelete(r.id) }
        }
      }
      if rows.isEmpty, error == nil { Text("만든 알림이 없어요").foregroundStyle(.secondary) }
      Divider()
      TextField("종목 (예: AAPL)", text: $symbol)
      HStack(spacing: 4) {
        ForEach(AlertCreate.conditions, id: \.0) { c in
          Button(c.1) { condition = c.0 }.buttonStyle(Pill(on: condition == c.0))
        }
      }
      TextField(news ? "키워드" : condition == "change_percent" ? "등락률 (%)" : "가격", text: $value)
      Button("만들기") {
        if let request { onCreate(request) }
        value = ""
      }
      .buttonStyle(Pill())
      .disabled(request == nil)
      if let error { Text(error).font(.callout).foregroundStyle(.secondary) }
    }
    .textFieldStyle(.roundedBorder)
  }

  static func label(_ condition: String) -> String {
    AlertCreate.conditions.first { $0.0 == condition }?.1 ?? condition
  }
}
