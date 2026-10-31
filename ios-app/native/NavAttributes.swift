import ActivityKit
import Foundation

// Współdzielone między aplikacją a rozszerzeniem widgetu
struct NavAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var dist: String        // „1,7 km”
        var instr: String       // „Jana Sobieskiego”
        var maneuver: Int       // typ ORS/TomTom 0–13
        var eta: String         // „16:30”
        var remKm: String       // „494 km”
        var remTime: String     // „5 h 3 min”
        var limit: Int          // 0 = brak
        var progress: Double    // 0–1
        var delay: String       // „+19 min” lub „”
    }
    var dest: String
}
