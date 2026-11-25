import Foundation
import Testing

@testable import FinClawMacCore

private let t0 = Date(timeIntervalSinceReferenceDate: 1_000)
private func face(_ mood: Mood, at t: Double, since: Date = t0, lastDeltaAt: Date? = nil, reduceMotion: Bool = false)
  -> FaceParams
{
  FaceParams.at(
    mood: mood, since: since, now: Date(timeIntervalSinceReferenceDate: t), lastDeltaAt: lastDeltaAt,
    reduceMotion: reduceMotion)
}

@Test func blinkOnlyInWindow() {
  for k in 230...240 {
    let start = FaceParams.blinkStart(k)
    #expect(face(.idle, at: start + 0.06).eyeOpen == 0.1)
    #expect(face(.idle, at: start - 0.01).eyeOpen == 1)
    #expect(face(.idle, at: start + 0.13).eyeOpen == 1)
  }
}

@Test func blinkDeterministic() {
  #expect(face(.idle, at: 1234.567) == face(.idle, at: 1234.567))
  #expect(face(.talking, at: 1234.567) == face(.talking, at: 1234.567))
}

@Test func mouthClosesAfter0_45s() {
  let now = 1_000.3
  let f = face(.talking, at: now, lastDeltaAt: Date(timeIntervalSinceReferenceDate: now - 0.46))
  #expect(f.mouth == .oval(h: 1.5))
}

@Test func reduceMotionIndependentOfTime() {
  for mood in Mood.allCases {
    #expect(face(mood, at: 1_000.1, reduceMotion: true) == face(mood, at: 1_777.7, reduceMotion: true), "\(mood)")
  }
  #expect(face(.talking, at: 1_000.1, reduceMotion: true).mouth == .oval(h: 1.5 + 6 * 0.5))
}

@Test func offlineFrozen() {
  let f = face(.offline, at: 1_000.8)
  #expect(f.breathX == 1)
  #expect(f.breathY == 1)
  #expect(f.prop == .z)
  #expect(f.gray)
}

@Test func alertJumpOnlyFirst0_6s() {
  #expect(face(.alert, at: 1_000.15).jumpY < 0)
  #expect(face(.alert, at: 1_000.7).jumpY == 0)
}

@Test func spinnerPeriod1_2s() {
  guard case .spinner(let a) = face(.working, at: 1_000.5).prop, case .spinner(let b) = face(.working, at: 1_001.7).prop
  else {
    Issue.record("not a spinner")
    return
  }
  #expect(abs(a - b) < 1e-6)
}

@Test func propsPerMood() {
  guard case .dots = face(.thinking, at: 1_000).prop else {
    Issue.record("thinking dots")
    return
  }
  guard case .spinner = face(.working, at: 1_000).prop else {
    Issue.record("working spinner")
    return
  }
  #expect(face(.alert, at: 1_000).prop == .bang)
  #expect(face(.error, at: 1_000).prop == .question)
  #expect(face(.idle, at: 1_000).prop == FaceParams.Prop.none)
}

@Test func copyToolLabels() {
  #expect(Copy.toolLabel("mcp__finclaw__route_task") == "알아보는 중…")
  #expect(Copy.toolLabel("mcp__finclaw__get_current_datetime") == nil)
  #expect(Copy.toolLabel("mcp__x__foo") == "도구 사용 중…")
}

@Test func copyAlertTitles() {
  #expect(Copy.alertTitle("AAPL price_above") == "AAPL 가격 알림")
  #expect(Copy.alertTitle("AAPL price_below") == "AAPL 가격 알림")
  #expect(Copy.alertTitle("005930.KS change_percent") == "005930.KS 등락 알림")
  #expect(Copy.alertTitle("TSLA news_match") == "TSLA 뉴스 알림")
  #expect(Copy.alertTitle("이상한값") == "알림")
}
