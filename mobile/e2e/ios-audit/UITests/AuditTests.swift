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
    app.open(URL(string: "courtbook-staging://\(path)")!)
    sleep(settle)
  }

  private func shot(_ name: String) {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try? png.write(to: out.appendingPathComponent("ios-\(name)-\(tag).png"))
  }

  private func reveal(_ el: XCUIElement) {
    var n = 0
    while !(el.exists && el.isHittable) && n < 6 { app.swipeUp(); n += 1 }
  }

  private func signInIfNeeded() {
    open("profile")
    let signIn = app.buttons["Sign in"]
    guard signIn.waitForExistence(timeout: 10) else { log("already signed in"); return }
    open("sign-in")
    let email = app.textFields["staging-email"]
    reveal(email)
    email.tap()
    email.typeText(env["E2E_EMAIL"] ?? "")
    let password = app.secureTextFields["staging-password"]
    reveal(password)
    password.tap()
    password.typeText(env["E2E_PASSWORD"] ?? "")
    let button = app.buttons["staging-sign-in"]
    reveal(button)
    button.tap()
    let ready = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Ready to play'")).firstMatch
    XCTAssertTrue(ready.waitForExistence(timeout: 30), "sign-in to the staging test account")
    log("signed in")
  }

  private func kind(_ t: XCUIAccessibilityAuditType) -> String {
    let names: [(XCUIAccessibilityAuditType, String)] = [
      (.contrast, "contrast"), (.elementDetection, "element-detection"), (.hitRegion, "hit-region"),
      (.sufficientElementDescription, "description"), (.dynamicType, "dynamic-type"),
      (.textClipped, "text-clipped"), (.trait, "trait"),
    ]
    return names.filter { t.contains($0.0) }.map(\.1).joined(separator: "+").ifEmpty("other")
  }

  private func audit(_ screen: String) {
    shot(screen)
    var count = 0
    do {
      try app.performAccessibilityAudit(for: .all) { issue in
        count += 1
        let el = issue.element
        let who = el.map { "label='\($0.label)' id='\($0.identifier)' type=\($0.elementType.rawValue) frame=\(NSCoder.string(for: $0.frame))" } ?? "no element"
        self.log("ISSUE \(self.tag) \(screen) [\(self.kind(issue.auditType))] \(issue.compactDescription) — \(who)")
        return true // recorded; the CI script decides
      }
    } catch {
      log("ERROR \(tag) \(screen) audit could not run: \(error)")
    }
    log("SCREEN \(tag) \(screen): \(count) issue(s)")
  }

  func testAuditMainScreens() throws {
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
      reveal(time); time.tap(); sleep(3); audit("club-selected")
    } else { log("no free time to select on \(date)") }
    let info = app.buttons["Info"]
    if info.waitForExistence(timeout: 5) { info.tap(); sleep(4); audit("club-info") }
    open("bookings"); audit("bookings")
    open("profile"); audit("profile")

    try? lines.joined(separator: "\n").appending("\n")
      .write(to: out.appendingPathComponent("ios-audit-\(tag).txt"), atomically: true, encoding: .utf8)
  }
}
