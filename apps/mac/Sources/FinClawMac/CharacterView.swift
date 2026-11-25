import AppKit
import FinClawMacCore
import SwiftUI

extension Color {
  init(hex: Int, opacity: Double = 1) {
    let red = Double(hex >> 16 & 255) / 255
    let green = Double(hex >> 8 & 255) / 255
    let blue = Double(hex & 255) / 255
    self.init(red: red, green: green, blue: blue, opacity: opacity)
  }
}

/// 캐릭터 96pt + 큐 배지(B7) + 접근성(B9). frozenAt 이 있으면 TimelineView 없이 그 시각으로 그린다(스냅샷, G8).
struct CharacterView: View {
  let state: CharacterState
  var frozenAt: Date?
  var onTap = {}
  var onBadge = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var drag: (mouse: NSPoint, origin: NSPoint, moved: Bool)?

  var body: some View {
    Group {
      if let t = frozenAt {
        canvas(t)
      } else {
        let paused = reduceMotion || state.mood == .offline
        TimelineView(.animation(minimumInterval: 1 / 30, paused: paused)) { canvas($0.date) }
      }
    }
    .frame(width: 96, height: 96)
    .contentShape(Rectangle())
    .gesture(move)
    .overlay(alignment: .topTrailing) {
      if !state.queue.isEmpty {
        Button(action: onBadge) {
          Text("\(state.queue.count)")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(Color(hex: Palette.ink))
            .frame(minWidth: 18, minHeight: 18)
            .background(Circle().fill(Color(hex: Palette.amber)))
        }
        .buttonStyle(.plain)
        .offset(x: 6, y: -6)  // 소품("!")과 겹치지 않게
        .accessibilityLabel("알림 \(state.queue.count)개 더 있어요")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Copy.accessibility(state.mood, toolLabel: state.toolLabel, alertTitle: alertTitle))
    .accessibilityHint("클릭하면 입력창이 열려요")
    .accessibilityAction(.default, onTap)
  }

  private var alertTitle: String? {
    if case .proactive(let p, _)? = state.bubble { p.title } else { nil }
  }

  private func canvas(_ now: Date) -> some View {
    let params = FaceParams.at(
      mood: state.mood, since: state.moodSince, now: now, lastDeltaAt: state.lastDeltaAt, reduceMotion: reduceMotion)
    return CharacterCanvas(params: params)
  }

  /// agentpet #55: onTapGesture 금지 — 단일 DragGesture 로 5pt 이상 = 창 이동, 미만 = 탭. 화면 좌표라 y 반전 불필요.
  private var move: some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { _ in
        guard let w = NSApp.windows.first(where: { $0 is CharacterPanel }) else { return }
        let m = NSEvent.mouseLocation
        let d = drag ?? (m, w.frame.origin, false)
        let (dx, dy) = (m.x - d.mouse.x, m.y - d.mouse.y)
        let moved = d.moved || hypot(dx, dy) >= 5
        if moved { w.setFrameOrigin(NSPoint(x: d.origin.x + dx, y: d.origin.y + dy)) }
        drag = (d.mouse, d.origin, moved)
      }
      .onEnded { _ in
        if drag?.moved != true { onTap() }
        drag = nil
      }
  }
}

/// plan §4-1 수치 그대로. 논리 100×100, 원점 좌상단, y 아래로.
struct CharacterCanvas: View {
  let params: FaceParams

  var body: some View {
    Canvas { ctx, size in
      let p = params
      let ink = Color(hex: Palette.ink)
      let outline = Color(hex: Palette.outline)
      let pen = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
      let s = min(size.width, size.height) / 100
      ctx.scaleBy(x: s, y: s)
      ctx.translateBy(x: 0, y: p.jumpY)  // 점프(음수 = 위)
      ctx.translateBy(x: 50, y: 90)  // 기울임·숨쉬기 기준점 (50, 90)
      ctx.rotate(by: .degrees(p.tiltDeg))
      ctx.scaleBy(x: p.breathX, y: p.breathY)
      ctx.translateBy(x: -50, y: -90)

      func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }
      func stroke(_ path: Path) { ctx.stroke(path, with: .color(ink), style: pen) }
      func segment(_ from: CGPoint, _ to: CGPoint) -> Path { Path { $0.addLines([from, to]) } }
      func curve(_ from: CGPoint, _ to: CGPoint, control: CGPoint) -> Path {
        var path = Path()
        path.move(to: from)
        path.addQuadCurve(to: to, control: control)
        return path
      }
      func oval(_ c: CGPoint, _ rx: Double, _ ry: Double, _ color: Color) {
        let rect = CGRect(x: c.x - rx, y: c.y - ry, width: rx * 2, height: ry * 2)
        ctx.fill(Path(ellipseIn: rect), with: .color(color))
      }

      // 등지느러미 — 회전 기준점 (56, 30)
      var fin = ctx
      fin.translateBy(x: 56, y: 30)
      fin.rotate(by: .degrees(p.finDeg))
      fin.translateBy(x: -56, y: -30)
      var finPath = curve(pt(44, 30), pt(57, 9), control: pt(45, 15))
      finPath.addQuadCurve(to: pt(68, 31), control: pt(66, 20))
      finPath.closeSubpath()
      fin.fill(finPath, with: .color(Color(hex: p.gray ? Palette.offlineBody : Palette.fin)))
      fin.stroke(finPath, with: .color(outline), style: pen)

      // 몸 — 외곽선 필수 (흰 배경 대비)
      let body = Path(roundedRect: CGRect(x: 14, y: 28, width: 72, height: 62), cornerRadius: 30)
      ctx.fill(body, with: .color(Color(hex: p.gray ? Palette.offlineBody : Palette.body)))
      ctx.stroke(body, with: .color(outline), style: pen)

      // 볼 — 표의 35%·55% 를 그대로 쓰면 민트 위에서 회색으로 보인다 → 1.8배 (분홍이 보이는 최소치, 스냅샷 확인)
      if p.cheekOpacity > 0 {
        let cheek = Color(hex: Palette.cheek, opacity: min(1, p.cheekOpacity * 1.8))
        for x in [29.0, 71] { oval(pt(x, 66), 5, 3, cheek) }
      }

      for x in [38.0, 62] {  // 눈 · 하이라이트
        let c = pt(x + p.eyeDX, 56 + p.eyeDY)
        switch p.eyes {
        case .open:
          oval(c, 5.5, 7.5 * p.eyeOpen * p.eyeScaleY, ink)
          if p.eyeOpen > 0.5 { oval(pt(c.x + 1.8, c.y - 2.8), 1.6, 1.6, .white.opacity(0.9)) }
        case .closedArc: stroke(curve(pt(c.x - 5, 55), pt(c.x + 5, 55), control: pt(c.x, 63)))
        case .happyArc: stroke(curve(pt(c.x - 5, 57), pt(c.x + 5, 57), control: pt(c.x, 47)))
        }
      }

      switch p.mouth {  // 기준 (50, 71)
      case .none: break
      case .smile(let cy): stroke(curve(pt(45, 69), pt(55, 69), control: pt(50, cy)))
      case .dot(let r): oval(pt(r < 2 ? 53 : 50, 72), r, r, ink)  // thinking 작은 점은 시선 쪽, alert 큰 점은 가운데
      case .line: stroke(segment(pt(46, 71), pt(54, 71)))
      case .oval(let h): oval(pt(50, 71), 4, h / 2, ink)
      case .wave:
        var wave = curve(pt(45, 72), pt(50, 70), control: pt(47.5, 73.5))
        wave.addQuadCurve(to: pt(55, 72), control: pt(52.5, 66.5))
        stroke(wave)
      }

      if p.browRaise > 0 {  // thinking: 오른 눈썹만 올림
        stroke(segment(pt(34, 45), pt(42, 45)))
        stroke(segment(pt(58, 45 - p.browRaise), pt(66, 45 - p.browRaise)))
      }
      if p.worriedBrows {  // 안쪽 끝 +2u
        stroke(segment(pt(34, 45), pt(42, 43)))
        stroke(segment(pt(58, 43), pt(66, 45)))
      }

      // 소품은 몸 밖(배경 위)에 놓이므로 잉크 소품엔 밝은 받침을 깐다 — 어두운 데스크톱에서도 보이게
      let prop = pt(84, 24)
      let backing = Color.white.opacity(0.9)
      switch p.prop {
      case .none, .bang, .question: break
      case .dots:
        let pill = Path(roundedRect: CGRect(x: 71, y: 18, width: 26, height: 12), cornerRadius: 6)
        ctx.fill(pill, with: .color(backing))
      case .z, .spinner: oval(prop, 7.5, 7.5, backing)
      }
      switch p.prop {
      case .none: break
      case .z: ctx.draw(Text("z").font(.system(size: 10, weight: .bold)).foregroundStyle(ink), at: prop)
      case .dots(let lit):  // 표의 (44/50/56, 18) 은 등지느러미와 겹쳐 소품 자리로 옮김
        for (i, x) in [77.0, 84, 91].enumerated() { oval(pt(x, 24), 1.8, 1.8, ink.opacity(i == lit ? 1 : 0.3)) }
      case .spinner(let angle):
        let arc = Path {
          $0.addArc(
            center: prop, radius: 5, startAngle: .degrees(angle), endAngle: .degrees(angle + 270), clockwise: false)
        }
        stroke(arc)
      case .bang, .question:
        oval(prop, 6, 6, Color(hex: Palette.amber))
        let mark = Text(p.prop == .bang ? "!" : "?").font(.system(size: 9, weight: .heavy)).foregroundStyle(ink)
        ctx.draw(mark, at: prop)
      }
    }
  }
}
