import Foundation
import Capacitor
import ActivityKit

// Wtyczka Capacitor: start / update / end Live Activity z JS (window.Capacitor.Plugins.LiveActivity)
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]

    private var activity: Activity<NavAttributes>?

    private func state(from call: CAPPluginCall) -> NavAttributes.ContentState {
        return NavAttributes.ContentState(
            dist: call.getString("dist") ?? "",
            instr: call.getString("instr") ?? "",
            maneuver: call.getInt("maneuver") ?? 6,
            eta: call.getString("eta") ?? "",
            remKm: call.getString("remKm") ?? "",
            remTime: call.getString("remTime") ?? "",
            limit: call.getInt("limit") ?? 0,
            progress: call.getDouble("progress") ?? 0,
            delay: call.getString("delay") ?? ""
        )
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": ActivityAuthorizationInfo().areActivitiesEnabled])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { call.resolve(["ok": false]); return }
        let attrs = NavAttributes(dest: call.getString("dest") ?? "Cel")
        let st = state(from: call)
        do {
            // zakończ ewentualną poprzednią
            for a in Activity<NavAttributes>.activities { Task { await a.end(nil, dismissalPolicy: .immediate) } }
            activity = try Activity.request(attributes: attrs, content: .init(state: st, staleDate: nil), pushType: nil)
            call.resolve(["ok": true])
        } catch {
            call.reject("Live Activity: \(error.localizedDescription)")
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let st = state(from: call)
        guard let a = activity ?? Activity<NavAttributes>.activities.first else { call.resolve(["ok": false]); return }
        Task { await a.update(.init(state: st, staleDate: nil)); call.resolve(["ok": true]) }
    }

    @objc func end(_ call: CAPPluginCall) {
        let acts = Activity<NavAttributes>.activities
        activity = nil
        Task { for a in acts { await a.end(nil, dismissalPolicy: .immediate) }; call.resolve(["ok": true]) }
    }
}
