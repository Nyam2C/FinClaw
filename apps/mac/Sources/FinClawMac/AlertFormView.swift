import SwiftUI

struct AlertCreate: Encodable { let symbol: String; let condition: String; let threshold: Double?; let keyword: String? }
struct AlertRow: Decodable, Identifiable { let id, symbol, condition: String; let threshold: Double?; let keyword: String? }

/// 알림 탭: 목록(행마다 2단계 삭제) + 만들기 폼. 조건 값은 서버 enum 그대로 (nil 필드는 인코드 생략).
struct AlertFormView: View {
  let rows: [AlertRow], error: String?, onCreate: (AlertCreate) -> Void, onDelete: (String) -> Void
  @State private var symbol = ""
  @State private var value = ""
  @State private var condition = "price_above"
  static let conditions = [("price_above", "이상"), ("price_below", "이하"), ("change_percent", "등락률"), ("news_match", "뉴스")]

  var body: some View {
    let news = condition == "news_match", number = Double(value)
    VStack(alignment: .leading, spacing: 8) {
      ForEach(rows) { r in
        HStack {
          Text("\(r.symbol) \(Self.label(r.condition)) \(r.keyword ?? r.threshold.map { String(format: "%g", $0) } ?? "")")
          Spacer()
          TwoStepButton(title: "삭제") { onDelete(r.id) }
        }
      }
      if rows.isEmpty, error == nil { Text("만든 알림이 없어요").foregroundStyle(.secondary) }
      Divider()
      TextField("종목 (예: AAPL)", text: $symbol)
      HStack(spacing: 4) {
        ForEach(Self.conditions, id: \.0) { c in Button(c.1) { condition = c.0 }.buttonStyle(Pill(on: condition == c.0)) }
      }
      TextField(news ? "키워드" : condition == "change_percent" ? "등락률 (%)" : "가격", text: $value)
      Button("만들기") {
        onCreate(
          AlertCreate(
            symbol: symbol.trimmingCharacters(in: .whitespaces), condition: condition, threshold: news ? nil : number,
            keyword: news ? value : nil))
        value = ""
      }
      .buttonStyle(Pill())
      .disabled(symbol.trimmingCharacters(in: .whitespaces).isEmpty || (news ? value.isEmpty : number == nil))
      if let error { Text(error).font(.callout).foregroundStyle(.secondary) }
    }
    .textFieldStyle(.roundedBorder)
  }

  static func label(_ condition: String) -> String { conditions.first { $0.0 == condition }?.1 ?? condition }
}
