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
    // What is on screen now, so a run that never reached the screen is visible in the log.
    let texts = labels(14)
    log("OPEN /\(path.split(separator: "?").first.map(String.init) ?? "") state=\(app.state.rawValue) shows: \(texts)")
  }

  private func shot(_ name: String) {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try? png.write(to: out.appendingPathComponent("ios-\(name)-\(tag).png"))
  }

  private func reveal(_ el: XCUIElement) {
    var n = 0
    while !(el.exists && el.isHittable) && n < 6 { app.swipeUp(); n += 1 }
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
    reveal(email)
    tapCentre(email)
    email.typeText((env["E2E_EMAIL"] ?? "") + "\n")
    let password = app.secureTextFields["staging-password"]
    reveal(password)
    tapCentre(password)
    password.typeText((env["E2E_PASSWORD"] ?? "") + "\n")
    let button = app.buttons["staging-sign-in"]
    reveal(button)
    tapCentre(button)
    log("typed email: \(email.value as? String ?? "?")")
    let ready = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Ready to play'")).firstMatch
    if ready.waitForExistence(timeout: 30) {
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

  /// Positive control: the audit must report problems on the host's deliberately broken screen.
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
      reveal(time); time.tap(); sleep(3); audit("club-selected")
    } else { log("no free time to select on \(date)") }
    let info = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Info'")).firstMatch
    if info.waitForExistence(timeout: 5) { info.tap(); sleep(4); audit("club-info") }
    open("bookings"); audit("bookings")
    open("profile"); audit("profile")

    try? lines.joined(separator: "\n").appending("\n")
      .write(to: out.appendingPathComponent("ios-audit-\(tag).txt"), atomically: true, encoding: .utf8)
  }
}
