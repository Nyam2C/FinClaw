import Foundation

/// 캐릭터 색 (plan §4-1). 스냅샷·테스트가 같은 값을 쓴다.
public enum Palette {
  public static let body = 0x4CC3AE, fin = 0x2E9C89, outline = 0x23786A, ink = 0x16302C
  public static let cheek = 0xFF8FA3, amber = 0xF5A623, offlineBody = 0xA7B0AE
}

/// mood·시각만으로 정해지는 얼굴 값 (plan §4-1 수식).
public struct FaceParams: Equatable, Sendable {
  public enum Mouth: Equatable, Sendable {
    case none, smile(controlY: Double), dot(r: Double), line, oval(h: Double), wave
  }
  public enum Prop: Equatable, Sendable { case none, dots(lit: Int), spinner(angle: Double), bang, question, z }
  public enum Eyes: Equatable, Sendable { case open, closedArc, happyArc }  // ∪ / ∩
  public var eyes = Eyes.open, eyeOpen = 1.0, eyeScaleY = 1.0, eyeDX = 0.0, eyeDY = 0.0
  public var mouth = Mouth.none, breathX = 1.0, breathY = 1.0, tiltDeg = 0.0, finDeg = 0.0, jumpY = 0.0
  public var cheekOpacity = 0.0, browRaise = 0.0 /* thinking 오른 눈썹 +3 */, worriedBrows = false
  public var prop = Prop.none, gray = false

  public static func at(mood: Mood, since: Date, now: Date, lastDeltaAt: Date?, reduceMotion: Bool) -> FaceParams {
    let t = reduceMotion ? 0 : now.timeIntervalSinceReferenceDate  // 주기 함수용
    let p = reduceMotion ? .infinity : now.timeIntervalSince(since)  // 진입 경과
    let wave = { (hz: Double) in sin(2 * .pi * hz * t) }
    let blink = !reduceMotion && blinking(t) ? 0.1 : 1
    var f = FaceParams()
    if mood != .offline {  // 숨쉬기, offline 은 1
      let s = sin(2 * .pi * t / (mood == .working ? 1.6 : 3.2))
      f.breathY = 1 + 0.025 * s
      f.breathX = 1 - 0.012 * s
    }
    switch mood {  // plan §4-1 mood 표
    case .offline:
      f.eyes = .closedArc
      f.prop = .z
      f.gray = true
    case .idle:
      f.eyeOpen = blink
      f.mouth = .smile(controlY: 74)
      f.cheekOpacity = 0.35
    case .listening:
      f.eyeScaleY = 1.1
      f.tiltDeg = 2
      f.mouth = .smile(controlY: 72)
    case .thinking:
      f.eyeScaleY = 0.75
      f.eyeDX = 2
      f.eyeDY = -2
      f.mouth = .dot(r: 1.6)
      f.browRaise = 3
      f.prop = .dots(lit: Int(t / 0.4) % 3)
    case .working:
      f.eyeScaleY = 0.55
      f.eyeDX = 2 * wave(0.8)
      f.mouth = .line
      f.finDeg = 4 * wave(1.2)
      f.prop = .spinner(angle: t.truncatingRemainder(dividingBy: 1.2) / 1.2 * 360)
    case .talking:
      let decay = lastDeltaAt.map { max(0, 1 - now.timeIntervalSince($0) / 0.45) } ?? 0
      f.eyeOpen = blink
      f.cheekOpacity = 0.35
      f.finDeg = 4 * wave(1.2)
      f.mouth = .oval(h: 1.5 + 6 * (reduceMotion ? 0.5 : abs(wave(4.5)) * decay))
    case .happy:
      f.eyes = .happyArc
      f.mouth = .smile(controlY: 77)
      f.cheekOpacity = 0.55
    case .alert:
      f.eyeScaleY = 1.2
      f.mouth = .dot(r: 3.2)
      f.prop = .bang
      if p < 0.6 { f.jumpY = -6 * abs(sin(.pi * p / 0.3)) }
      if p < 1.2 { f.finDeg = 10 * wave(3) }
    case .error:
      f.eyeScaleY = 0.8
      f.worriedBrows = true
      f.mouth = .wave
      f.prop = .question
    }
    return f
  }

  /// 구간 k 의 깜빡임 시작 — k·4.2 + 3.0 + 2.5·hash(k). 결정적 hash, 음수 안전.
  static func blinkStart(_ k: Int) -> Double {
    let h = Double(UInt64(bitPattern: Int64(k)) &* 2_654_435_761 % 1000) / 1000
    return Double(k) * 4.2 + 3.0 + 2.5 * h
  }

  /// 시작 오프셋이 4.2 를 넘을 수 있으므로 직전 구간(k-1)도 본다.
  static func blinking(_ t: Double) -> Bool {
    let k = Int(floor(t / 4.2))
    return [k - 1, k].contains { t >= blinkStart($0) && t < blinkStart($0) + 0.12 }
  }
}
