import AppKit
import SwiftUI

/// 투명·테두리 없음·항상 위·전 Space 캐릭터 패널 ([L1] §4).
/// 클릭해도 앱을 활성화하지 않고(.nonactivatingPanel), TextField 를 클릭할 때만 key 가 된다
/// (becomesKeyOnlyIfNeeded → hit view 의 needsPanelToBecomeKey 가 true 일 때만).
final class CharacterPanel: NSPanel {
  init(rootView: some View) {
    super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true  // level = .floating
    becomesKeyOnlyIfNeeded = true
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    isMovableByWindowBackground = true
    isReleasedWhenClosed = false
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    let host = FirstMouseHostingView(rootView: rootView)
    let size = host.fittingSize  // 창 = 내용 크기 → 투명 여백(클릭 가로채는 영역) 최소화
    host.sizingOptions = []  // 이후 창 크기는 fit(_:) 만 바꾼다 (fittingSize 는 이 설정 전에 읽어야 0 이 아니다)
    contentView = host
    if !setFrameUsingName("FinClawCharacter") {  // 위치 기억: AppKit 내장 autosave(UserDefaults)
      let v = NSScreen.main?.visibleFrame ?? .zero
      setFrameOrigin(NSPoint(x: v.maxX - size.width - 24, y: v.minY + 24))
    }
    setFrame(NSRect(origin: frame.origin, size: size), display: false)  // 저장된 크기 말고 위치만 쓴다 (0×0 이면 레이아웃이 안 돈다)
    setFrameAutosaveName("FinClawCharacter")
    ensureOnScreen()
  }

  override var canBecomeKey: Bool { true }  // borderless 기본값 false → 이게 없으면 TextField 입력 불가
  override var canBecomeMain: Bool { false }

  /// 모니터 분리·해상도 변경 후 화면 밖이면 보이는 화면 안으로 되돌린다.
  func ensureOnScreen() {
    let screen = NSScreen.screens.first { $0.visibleFrame.intersects(frame) } ?? NSScreen.main
    guard let v = screen?.visibleFrame else { return }
    setFrameOrigin(
      NSPoint(
        x: min(max(frame.minX, v.minX), v.maxX - frame.width),
        y: min(max(frame.minY, v.minY), v.maxY - frame.height)))
  }

  /// 말풍선·펼침으로 내용 크기가 바뀌면 우하단 기준점을 유지한다 (AppKit 좌표: 원점 좌하단 → maxX·minY 고정).
  func fit(_ size: NSSize) {
    guard size != frame.size else { return }
    setFrame(NSRect(x: frame.maxX - size.width, y: frame.minY, width: size.width, height: size.height), display: true)
    ensureOnScreen()
  }
}

/// 비활성 상태 첫 클릭이 "창 활성화"에 먹히지 않고 바로 버튼/제스처로 가게 한다.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
