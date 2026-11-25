import Foundation
import Testing

@testable import FinClawMacCore

private let t0 = Date(timeIntervalSinceReferenceDate: 1_000)
private func apply(_ s: inout CharacterState, _ e: CharacterEvent, _ n: Double = 0) {
  CharacterReducer.reduce(&s, e, now: t0 + n)
}
private func sv(_ e: ServerEvent) -> CharacterEvent { .client(.server(e)) }
private func idle() -> CharacterState {
  var s = CharacterState(now: t0)
  apply(&s, .client(.connected))
  return s
}
private func running(_ id: String = "r1") -> CharacterState {
  var s = idle()
  apply(&s, .sent(runId: id))
  return s
}
private func alert(_ key: String, _ message: String = "m") -> CharacterEvent {
  sv(.alertTriggered(AlertTriggered(alertId: key, name: "AAPL price_above", message: message, currentValue: "1", triggeredAt: 0)))
}
private func briefing(_ key: String, output: String = "o", error: String? = nil) -> CharacterEvent {
  sv(.scheduleCompleted(ScheduleCompleted(scheduleId: key, name: "아침", runId: nil, output: output, error: error, completedAt: 0)))
}
private func tool(_ callId: String, _ name: String, _ phase: ToolPhase, isError: Bool = false, run: String = "r1")
  -> CharacterEvent
{
  sv(.tool(runId: run, toolCallId: callId, name: name, phase: phase, isError: isError))
}
private func shown(_ s: CharacterState) -> Proactive? {
  if case .proactive(let p, _)? = s.bubble { return p }
  return nil
}

@Test(arguments: Mood.allCases) func disconnectFromAnyMoodGoesOffline(mood: Mood) {
  var s = idle()
  s.mood = mood
  apply(&s, .client(.disconnected(.serverDown)))
  #expect(s.mood == .offline)
}

@Test func disconnectDuringRunSetsLostRun() {
  var s = running()
  apply(&s, sv(.delta(runId: "r1", text: "가")))
  apply(&s, .client(.disconnected(.serverDown)))
  #expect(s.lostRun)
  #expect(s.runId == nil)
  #expect(s.bubble == nil)
}

@Test func connectedAfterLongOutageNotice() {
  var s = idle()
  apply(&s, .client(.disconnected(.serverDown)))
  apply(&s, .client(.connected), 11)
  #expect(s.mood == .idle)
  #expect(s.bubble == .notice("다시 연결됐어요", closesAt: t0 + 14))
}

@Test func connectedAfterShortOutageSilent() {
  var s = idle()
  apply(&s, .client(.disconnected(.serverDown)))
  apply(&s, .client(.connected), 3)
  #expect(s.mood == .idle)
  #expect(s.bubble == nil)
}

@Test func connectedWithLostRunNotice() {
  var s = running()
  apply(&s, .client(.disconnected(.serverDown)), 1)
  apply(&s, .client(.connected), 2)
  #expect(s.bubble == .notice(Copy.lostRun, closesAt: t0 + 10))
  #expect(!s.lostRun)
}

@Test func shutdownReason() {
  var s = idle()
  apply(&s, sv(.shutdown))
  #expect(s.mood == .offline)
  #expect(s.offlineReason == .shutdown)
}

@Test func offlineNoticeAfter10s() {
  var s = idle()
  apply(&s, .client(.disconnected(.serverDown)))
  apply(&s, .tick(holdBubble: false), 9)
  #expect(s.bubble == nil)
  apply(&s, .tick(holdBubble: false), 10)
  #expect(s.bubble == .notice(Copy.offline(.serverDown), closesAt: .distantFuture))
}

@Test func inputFocusIdleListening() {
  var s = idle()
  apply(&s, .inputFocused(true))
  #expect(s.mood == .listening)
  apply(&s, .inputFocused(false))
  #expect(s.mood == .idle)
  var r = running()
  apply(&r, .inputFocused(true))
  #expect(r.mood == .thinking)
  #expect(r.inputFocused)
}

@Test func sentGoesThinking() {
  let s = running()
  #expect(s.mood == .thinking)
  #expect(s.runId == "r1")
  #expect(s.bubble == .answer(text: "", closesAt: nil))
}

@Test func otherRunIdIgnored() {
  var s = running()
  let before = s
  apply(&s, sv(.delta(runId: "r2", text: "x")), 1)
  apply(&s, sv(.end(runId: "r2", text: "x")), 2)
  #expect(s == before)
}

@Test func nilRunIdIgnored() {
  var s = idle()
  let before = s
  apply(&s, sv(.delta(runId: "r1", text: "x")), 1)
  #expect(s == before)
}

@Test func deltaAccumulatesTalking() {
  var s = running()
  apply(&s, sv(.delta(runId: "r1", text: "가")), 1)
  apply(&s, sv(.delta(runId: "r1", text: "나")), 2)
  #expect(s.bubble == .answer(text: "가나", closesAt: nil))
  #expect(s.mood == .talking)
  #expect(s.lastDeltaAt == t0 + 2)
}

@Test func deltaDuringWorkingStaysWorking() {
  var s = running()
  apply(&s, tool("a", "mcp__finclaw__route_task", .start))
  apply(&s, sv(.delta(runId: "r1", text: "가")))
  #expect(s.mood == .working)
}

@Test func toolStartWorkingWithLabel() {
  var s = running()
  apply(&s, tool("a", "mcp__finclaw__route_task", .start))
  #expect(s.mood == .working)
  #expect(s.toolLabel == "알아보는 중…")
}

@Test func datetimeToolInvisible() {
  var s = running()
  apply(&s, sv(.delta(runId: "r1", text: "가")))
  apply(&s, tool("d", "mcp__finclaw__get_current_datetime", .start))
  apply(&s, tool("d", "mcp__finclaw__get_current_datetime", .end))
  #expect(s.mood == .talking)
  #expect(s.activeTools.isEmpty)
}

@Test func toolEndBackToThinking() {
  var s = running()
  apply(&s, tool("a", "mcp__finclaw__route_task", .start))
  apply(&s, tool("a", "mcp__finclaw__route_task", .end))
  #expect(s.mood == .thinking)
  #expect(s.toolLabel == nil)
}

@Test func toolErrorIsNotError() {
  var s = running()
  apply(&s, tool("a", "mcp__finclaw__route_task", .start))
  apply(&s, tool("a", "mcp__finclaw__route_task", .end, isError: true))
  #expect(s.mood == .thinking)
}

@Test func parallelToolsKeepLatestLabel() {
  var s = running()
  apply(&s, tool("a", "mcp__finclaw__route_task", .start))
  apply(&s, tool("b", "mcp__finclaw__list_alerts", .start))
  #expect(s.toolLabel == "알림 목록 보는 중…")
  apply(&s, tool("b", "mcp__finclaw__list_alerts", .end))
  #expect(s.mood == .working)
  #expect(s.toolLabel == "알아보는 중…")
}

@Test func endHappyWithClose() {
  var s = running()
  let text = String(repeating: "x", count: 80)
  apply(&s, sv(.end(runId: "r1", text: text)), 1)
  #expect(s.mood == .happy)
  #expect(s.bubble == .answer(text: text, closesAt: t0 + 15))  // 4 + 80/8 = 14s
  #expect(s.runId == nil)
}

@Test func happyToTalkingAfter1_2s() {
  var s = running()
  apply(&s, sv(.end(runId: "r1", text: "x")))
  apply(&s, .tick(holdBubble: false), 1.1)
  #expect(s.mood == .happy)
  apply(&s, .tick(holdBubble: false), 1.2)
  #expect(s.mood == .talking)
}

@Test func holdBubbleDefersCloseButNotHappy() {
  var s = running()
  apply(&s, sv(.end(runId: "r1", text: "x")))  // closesAt +6
  apply(&s, .tick(holdBubble: true), 7)
  #expect(s.bubble == .answer(text: "x", closesAt: t0 + 6))
  #expect(s.mood == .talking)
  apply(&s, .tick(holdBubble: false), 7.5)
  #expect(s.bubble == nil)
  #expect(s.mood == .idle)
}

@Test func abortedSkipsError() {
  var s = running()
  apply(&s, sv(.runError(runId: "r1", reason: "aborted")))
  #expect(s.mood == .idle)
  #expect(s.bubble == nil)
  #expect(s.runId == nil)
}

@Test func abortedShowsQueued() {
  var s = running()
  apply(&s, alert("A"))
  #expect(s.queue.count == 1)
  apply(&s, sv(.runError(runId: "r1", reason: "aborted")))
  #expect(s.mood == .alert)
  #expect(shown(s)?.key == "A")
  #expect(s.queue.isEmpty)
}

@Test func runErrorMapsReason() {
  var s = running()
  apply(&s, sv(.runError(runId: "r1", reason: "auth")))
  #expect(s.mood == .error)
  #expect(s.bubble == .error(Copy.reason("auth"), closesAt: t0 + 5))
}

@Test func immediateRunErrorAfterSent() {
  var s = idle()
  apply(&s, .sent(runId: "r1"))
  apply(&s, sv(.runError(runId: "r1", reason: "timeout")))
  #expect(s.mood == .error)
  #expect(s.bubble == .error(Copy.reason("timeout"), closesAt: t0 + 5))
}

@Test func requestFailedAlways() {
  var s = idle()
  apply(&s, .requestFailed)
  #expect(s.mood == .error)
  #expect(s.bubble == .error(Copy.requestFailed, closesAt: t0 + 5))
}

@Test func proactiveWhileIdleShows() {
  var s = idle()
  apply(&s, alert("A"))
  #expect(s.mood == .alert)
  #expect(s.bubble?.closesAt == t0 + 60)
  var b = idle()
  apply(&b, briefing("S"))
  #expect(b.mood == .alert)
  #expect(b.bubble?.closesAt == t0 + 30)
}

@Test func proactiveDuringRunQueues() {
  var s = running()
  apply(&s, alert("A"))
  #expect(s.queue.map(\.key) == ["A"])
  #expect(s.mood == .thinking)
  apply(&s, sv(.end(runId: "r1", text: "x")), 1)
  #expect(s.mood == .happy)
  let closes = s.bubble!.closesAt!
  apply(&s, .tick(holdBubble: false), closes.timeIntervalSince(t0))
  #expect(s.mood == .alert)
  #expect(shown(s)?.key == "A")
  #expect(s.queue.isEmpty)
}

@Test func sameKeyMerges() {
  var s = running()
  apply(&s, alert("A", "첫"))
  apply(&s, alert("A", "둘"))
  #expect(s.queue.count == 1)
  #expect(s.queue[0].count == 2)
  #expect(s.queue[0].body == "둘")
}

@Test func sameKeyOnScreenMerges() {
  var s = idle()
  apply(&s, alert("A", "첫"))
  apply(&s, alert("A", "둘"), 5)
  #expect(shown(s)?.count == 2)
  #expect(shown(s)?.body == "둘")
  #expect(s.bubble?.closesAt == t0 + 60)
}

@Test func otherKeyWhileProactiveQueues() {
  var s = idle()
  apply(&s, alert("A"))
  apply(&s, alert("B"))
  #expect(shown(s)?.key == "A")
  #expect(s.queue.map(\.key) == ["B"])
}

@Test func proactiveDisabledQueues() {
  var s = idle()
  apply(&s, .setProactive(false))
  apply(&s, alert("A"))
  #expect(s.queue.map(\.key) == ["A"])
  #expect(s.mood == .idle)
  #expect(s.bubble == nil)
}

@Test func enableShowsQueueHead() {
  var s = idle()
  apply(&s, .setProactive(false))
  apply(&s, alert("A"))
  apply(&s, .setProactive(true))
  #expect(s.mood == .alert)
  #expect(shown(s)?.key == "A")
}

@Test func briefingErrorBody() {
  var s = idle()
  apply(&s, briefing("S", error: "boom"))
  #expect(shown(s)?.body == Copy.briefingFailed("아침"))
  #expect(shown(s)?.detail == nil)
  #expect(shown(s)?.title == "브리핑 · 아침")
}

@Test func briefingBodyFirst6Lines() {
  var s = idle()
  let output = (1...10).map { "줄\($0)" }.joined(separator: "\n")
  apply(&s, briefing("S", output: output))
  #expect(shown(s)?.body == (1...6).map { "줄\($0)" }.joined(separator: "\n"))
  #expect(shown(s)?.detail == output)
}

@Test func dismissNextOrIdle() {
  var s = idle()
  apply(&s, alert("A"))
  apply(&s, alert("B"))
  apply(&s, .dismiss)
  #expect(shown(s)?.key == "B")
  #expect(s.mood == .alert)
  apply(&s, .dismiss)
  #expect(s.bubble == nil)
  #expect(s.mood == .idle)
}

@Test func dismissIgnoredDuringRun() {
  var s = running()
  apply(&s, .dismiss)
  #expect(s.bubble == .answer(text: "", closesAt: nil))
  #expect(s.mood == .thinking)
}

@Test func expiredProactiveWhileOfflineKeepsOffline() {
  var s = idle()
  apply(&s, alert("A"))
  apply(&s, .client(.disconnected(.serverDown)), 1)
  #expect(shown(s)?.key == "A")
  apply(&s, .tick(holdBubble: false), 61)
  #expect(s.mood == .offline)
  #expect(shown(s) == nil)
}

@Test func noticeRules() {
  var s = idle()
  apply(&s, .notice(Copy.resetDone))
  #expect(s.bubble == .notice(Copy.resetDone, closesAt: t0 + 3))
  var a = running()
  apply(&a, .notice(Copy.resetDone))
  #expect(a.bubble == .answer(text: "", closesAt: nil))
  var o = CharacterState(now: t0)
  apply(&o, .notice(Copy.resetDone))
  #expect(o.bubble == nil)
}

// MARK: - phase47 리뷰 수정 (R2)

@Test func requestFailedWhileOfflineStaysOffline() {
  var s = idle()
  apply(&s, .client(.disconnected(.serverDown)))
  apply(&s, .requestFailed)  // 끊긴 뒤 도착한 reset·send 실패
  #expect(s.mood == .offline)
  #expect(s.bubble == nil)
}

@Test func abandonedRunGoesIdleAndIgnoresLateEvents() {
  var s = running()
  apply(&s, .abandoned(runId: "other"))
  #expect(s.runId == "r1")
  apply(&s, .abandoned(runId: "r1"))
  #expect(s.mood == .idle)
  #expect(s.runId == nil)
  #expect(s.bubble == nil)
  apply(&s, sv(.end(runId: "r1", text: "늦은 답")))
  #expect(s.mood == .idle)
  #expect(s.bubble == nil)
}

@Test func bubbleCloseWhileTypingWaitsThenShowsQueue() {
  var s = running()
  apply(&s, sv(.end(runId: "r1", text: "답")))
  apply(&s, alert("a1"))  // 답 말풍선 표시 중 → 큐
  apply(&s, .inputFocused(true))  // 답을 보며 다음 질문 입력
  apply(&s, .tick(holdBubble: false), 30)
  #expect(s.bubble == nil)
  #expect(s.mood == .listening)
  #expect(s.queue.count == 1)
  apply(&s, .inputFocused(false), 31)
  #expect(s.mood == .alert)
  #expect(shown(s)?.key == "a1")
  #expect(s.queue.isEmpty)
}
