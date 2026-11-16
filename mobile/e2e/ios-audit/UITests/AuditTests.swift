import XCTest

/// Runs Apple's accessibility audit on each main screen of CourtBook Staging (already installed on
/// this simulator) and writes every issue, plus a screenshot per screen, to OUT_DIR. Issues are
/// recorded, not raised here: the CI script decides what fails the run.
private extension String {
  func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}

final class AuditTests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private lazy var app = XCUIApplication(bundleIdentifier: "app.courtbook.mobile.staging")
  private lazy var out = URL(fileURLWithPath: env["OUT_DIR"] ?? NSTemporaryDirectory())
  private lazy var tag = env["AUDIT_TAG"] ?? "run"
  private var lines: [String] = []

  private func log(_ s: String) {
    print("AUDIT| \(s)")
    lines.append(s)
  }

  private func open(_ path: String, settle: UInt32 = 5) {
    dismissSystemSheets()
    app.open(URL(string: "courtbook-staging://\(path)")!)
    sleep(settle)
    // What is on screen now, so a run that never reached the screen is visible in the log.
    let texts = labels(14)
    log("OPEN /\(path.split(separator: "?").first.map(String.init) ?? "") state=\(app.state.rawValue) shows: \(texts)")
  }

  private func shot(_ name: String) {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try? png.write(to: out.appendingPathComponent("ios-\(name)-\(tag).png"))
  }

  /// Wait for the element, then scroll it into reach if it is below the fold.
  @discardableResult
  private func reveal(_ el: XCUIElement) -> Bool {
    guard el.waitForExistence(timeout: 15) else {
      log("not on screen: \(el.description); showing \(labels())"); return false
    }
    var n = 0
    while !el.isHittable && n < 4 { app.swipeUp(); n += 1 }
    return true
  }

  /// Labels on screen, read from one snapshot (stable while the screen changes).
  private func labels(_ max: Int = 25) -> [String] {
    guard let root = try? app.snapshot() else { return [] }
    var out: [String] = []
    func walk(_ e: XCUIElementSnapshot) {
      if !e.label.isEmpty && out.last != e.label { out.append(e.label) }
      e.children.forEach(walk)
    }
    walk(root)
    return Array(out.prefix(max))
  }

  /// Focus, wait for the keyboard, then type one character at a time: the app's text fields are
  /// re-rendered on every keystroke, and fast typing on CI simulators drops or repeats characters.
  /// A visible field is checked; if the text is wrong, the field is emptied and typed again.
  private func type(into field: XCUIElement, _ text: String, check: Bool) {
    for attempt in 1...3 {
      tapCentre(field)
      _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
      sleep(1)
      if check, let old = field.value as? String, !old.isEmpty, old != field.placeholderValue {
        for _ in 0..<(old.count + 2) { field.typeText(XCUIKeyboardKey.delete.rawValue); usleep(60_000) }
      }
      for ch in text { field.typeText(String(ch)); usleep(120_000) }
      let got = field.value as? String ?? ""
      field.typeText("\n")
      if !check || got == text { return }
      log("typing attempt \(attempt) gave \(got.count) of \(text.count) characters; retrying")
    }
  }

  /// iOS offers to save the password after sign-in; that sheet covers the app.
  private func dismissSystemSheets() {
    let notNow = app.buttons["Not Now"]
    if notNow.waitForExistence(timeout: 2) { notNow.tap(); log("dismissed Save Password"); sleep(1) }
  }

  private func tapCentre(_ el: XCUIElement) {
    el.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
  }

  private func signInIfNeeded() {
    open("profile")
    let signIn = app.buttons["Sign in"]
    let signedIn = app.staticTexts.matching(NSPredicate(format: "label CONTAINS '@courtbook.test'")).firstMatch
    if signedIn.waitForExistence(timeout: 3) { log("already signed in"); return }
    guard signIn.waitForExistence(timeout: 20) else {
      log("neither signed in nor a Sign in button: \(labels())")
      XCTFail("profile did not settle"); return
    }
    open("sign-in")
    // Typing "\n" closes the keyboard (single-line fields blur on return), so the next field and the
    // button are not hidden behind it. A tap at the element's centre works even when XCUITest calls
    // a control inside a sheet "not hittable".
    let email = app.textFields["staging-email"]
    guard reveal(email) else { XCTFail("sign-in screen did not show the test account fields"); return }
    type(into: email, (env["E2E_EMAIL"] ?? ""), check: true)
    let password = app.secureTextFields["staging-password"]
    reveal(password)
    type(into: password, (env["E2E_PASSWORD"] ?? ""), check: false)
    let button = app.buttons["staging-sign-in"]
    reveal(button)
    tapCentre(button)
    sleep(3)
    dismissSystemSheets()
    // Sign-in returns to where it was opened from (Home, or Profile): either shows the account.
    let ready = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Ready to play' OR label CONTAINS '@courtbook.test'")).firstMatch
    // iOS's Save Password sheet can appear several seconds after sign-in and hides the app beneath it.
    var done = false
    for _ in 0..<10 {
      dismissSystemSheets()
      if ready.waitForExistence(timeout: 3) { done = true; break }
    }
    if done {
      log("signed in")
    } else {
      shot("signin-failed")
      log("sign-in did not finish; on screen: \(labels(40))")
      XCTFail("sign-in to the staging test account")
    }
  }

  private func kind(_ t: XCUIAccessibilityAuditType) -> String {
    let names: [(XCUIAccessibilityAuditType, String)] = [
      (.contrast, "contrast"), (.elementDetection, "element-detection"), (.hitRegion, "hit-region"),
      (.sufficientElementDescription, "description"), (.dynamicType, "dynamic-type"),
      (.textClipped, "text-clipped"), (.trait, "trait"),
    ]
    return names.filter { t.contains($0.0) }.map(\.1).joined(separator: "+").ifEmpty("other")
  }

  /// One audit pass: each issue as (kind, text) so two passes can be compared.
  private func auditPass() -> [(String, String)] {
    let before = labels(400)
    var found: [(String, String)] = []
    do {
      try app.performAccessibilityAudit(for: .all) { issue in
        let el = issue.element
        let who = el.map { "label='\($0.label)' id='\($0.identifier)' type=\($0.elementType.rawValue) frame=\(NSCoder.string(for: $0.frame))" } ?? "no element"
        found.append((self.kind(issue.auditType), "\(issue.compactDescription) — \(who) — \(issue.detailedDescription.replacingOccurrences(of: "\n", with: " "))"))
        return true // recorded; the CI script decides
      }
    } catch {
      log("ERROR \(tag) audit could not run: \(error)")
    }
    // The "potentially inaccessible text" check compares a picture of the screen with the
    // accessibility tree. If any text on screen changed while the audit ran ("Checked 30 s ago"
    // becoming "35 s ago"), an unattributed finding of that kind says nothing about the screen.
    if labels(400) != before {
      let unattributed = found.filter { $0.0 == "element-detection" && $0.1.contains("— no element —") }
      if !unattributed.isEmpty {
        log("TRANSIENT \(tag) screen text changed during the audit; \(unattributed.count) unattributed text finding(s) set aside")
        found.removeAll { $0.0 == "element-detection" && $0.1.contains("— no element —") }
      }
    }
    return found
  }

  /// Audits the screen. A finding must show up in two passes a few seconds apart: Apple's "potentially
  /// inaccessible text" check compares a picture of the screen with the accessibility tree, and text
  /// that changes in between (a sheet animating away, "Checked 33 s ago" ticking) is reported once
  /// with no element. Real problems are still there on the second pass.
  private func audit(_ screen: String) {
    dismissSystemSheets()   // a late Save Password sheet would be audited instead of the screen
    shot(screen)
    let first = auditPass()
    var confirmed = first
    if !first.isEmpty {
      sleep(3)
      let second = auditPass().map { "\($0.0)|\($0.1)" }
      confirmed = first.filter { second.contains("\($0.0)|\($0.1)") }
      for f in first where !second.contains("\(f.0)|\(f.1)") { log("TRANSIENT \(tag) \(screen) [\(f.0)] \(f.1)") }
    }
    for f in confirmed { log("ISSUE \(tag) \(screen) [\(f.0)] \(f.1)") }
    log("SCREEN \(tag) \(screen): \(confirmed.count) issue(s)")
  }

  func testA_AuditFindsKnownProblems() throws {
    let host = XCUIApplication()
    host.launch()
    var found: [String] = []
    try host.performAccessibilityAudit(for: .all) { issue in
      found.append(self.kind(issue.auditType)); return true
    }
    log("CONTROL \(tag) broken screen: \(found.count) issue(s) \(found)")
    XCTAssertFalse(found.isEmpty, "the audit found nothing on a deliberately broken screen, so it cannot be trusted")
    host.terminate()
  }

  /// Can the simulator reach the staging database at all (independently of the app)?
  private func networkCheck() {
    let done = expectation(description: "network")
    let url = URL(string: "https://pwznauyioqykdwodwpvx.supabase.co/auth/v1/health")!
    URLSession.shared.dataTask(with: url) { _, response, error in
      self.log("NETWORK staging: \((response as? HTTPURLResponse)?.statusCode.description ?? "no answer") \(error.map { "\($0)" } ?? "")")
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 20)
  }

  func testB_AuditMainScreens() throws {
    networkCheck()
    app.launch()
    let any = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Book a court' OR label BEGINSWITH 'Ready to play'")).firstMatch
    XCTAssertTrue(any.waitForExistence(timeout: 120), "app started")
    signInIfNeeded()

    let club = env["E2E_CLUB"] ?? ""
    let date = env["E2E_DATE"] ?? ""
    open(""); audit("home")
    open("courts"); audit("courts")
    open("club/\(club)?date=\(date)", settle: 8); audit("club-book")
    let time = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'time-'")).firstMatch
    if time.waitForExistence(timeout: 10) {
      reveal(time); tapCentre(time); sleep(3); audit("club-selected")
      // Apple's audit doesn't see text that wraps inside its box; a time tile that grew far taller
      // than it is wide means "08:00" or its label broke over lines.
      let tiles = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'time-'")).allElementsBoundByIndex
      for t in tiles where t.exists && t.frame.height > t.frame.width * 1.3 {
        log("ISSUE \(tag) club-book [layout] time tile too tall, its text wrapped — label='\(t.label)' id='\(t.identifier)' frame=\(NSCoder.string(for: t.frame))")
      }
    } else { log("no free time to select on \(date)") }
    let info = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Info'")).firstMatch
    if info.waitForExistence(timeout: 5) { info.tap(); sleep(4); audit("club-info") }
    open("bookings"); audit("bookings")
    open("profile"); audit("profile")

    try? lines.joined(separator: "\n").appending("\n")
      .write(to: out.appendingPathComponent("ios-audit-\(tag).txt"), atomically: true, encoding: .utf8)
  }
}
