import SwiftUI

// Placeholder host Xcode needs for a UI-test bundle; the tests drive CourtBook Staging. It also holds
// a deliberately broken screen: the audit must find problems here, or its "0 issues" on CourtBook
// would prove nothing.
@main struct AuditHostApp: App {
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 2) {
        Text("Low contrast, fixed tiny text").font(.system(size: 9)).foregroundColor(Color(white: 0.85))
        Image(systemName: "xmark").resizable().frame(width: 8, height: 8).onTapGesture {}
      }
    }
  }
}
