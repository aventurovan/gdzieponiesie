import Foundation
import Capacitor
import AVFoundation

// Głos nawigacji zgodnie z zaleceniami Apple dla aplikacji nawigacyjnych:
// kategoria .playback + tryb .voicePrompt, ściszanie innych dźwięków (muzyka, radio w aucie),
// sesja aktywowana tylko na czas komunikatu → działa przez głośnik, Bluetooth i CarPlay, także przy zablokowanym ekranie.
@objc(NavVoicePlugin)
public class NavVoicePlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "NavVoicePlugin"
    public let jsName = "NavVoice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "route", returnType: CAPPluginReturnPromise),
    ]

    private let synth = AVSpeechSynthesizer()
    private var pending: [ObjectIdentifier: CAPPluginCall] = [:]

    override public func load() {
        synth.delegate = self
        if #available(iOS 13.0, *) { synth.usesApplicationAudioSession = true }
    }

    private func activate() {
        let s = AVAudioSession.sharedInstance()
        do {
            var opts: AVAudioSession.CategoryOptions = [.duckOthers, .allowBluetoothA2DP]
            opts.insert(.interruptSpokenAudioAndMixWithOthers)
            try s.setCategory(.playback, mode: .voicePrompt, options: opts)
            try s.setActive(true)
        } catch { NSLog("NavVoice: audio session \(error)") }
    }

    private func deactivate() {
        if synth.isSpeaking { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        if text.isEmpty { call.resolve(); return }
        DispatchQueue.main.async {
            if call.getBool("urgent") ?? false { self.synth.stopSpeaking(at: .immediate) }
            self.activate()
            let u = AVSpeechUtterance(string: text)
            if let id = call.getString("voice"), let v = AVSpeechSynthesisVoice(identifier: id) { u.voice = v }
            else { u.voice = AVSpeechSynthesisVoice(language: call.getString("lang") ?? "pl-PL") }
            u.rate = Float(call.getDouble("rate") ?? 1.0) * AVSpeechUtteranceDefaultSpeechRate
            u.volume = 1.0
            u.prefersAssistiveTechnologySettings = false
            self.pending[ObjectIdentifier(u)] = call
            self.synth.speak(u)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.synth.stopSpeaking(at: .immediate); self.deactivate(); call.resolve() }
    }

    @objc func voices(_ call: CAPPluginCall) {
        let list = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("pl") }.map { v -> [String: Any] in
            var q = "default"; if v.quality == .enhanced { q = "enhanced" }
            if #available(iOS 16.0, *), v.quality == .premium { q = "premium" }
            return ["id": v.identifier, "name": v.name, "lang": v.language, "quality": q]
        }
        call.resolve(["voices": list])
    }

    // diagnostyka: dokąd idzie dźwięk (głośnik, Bluetooth, CarPlay)
    @objc func route(_ call: CAPPluginCall) {
        let outs = AVAudioSession.sharedInstance().currentRoute.outputs.map { "\($0.portType.rawValue):\($0.portName)" }
        call.resolve(["outputs": outs.joined(separator: ", ")])
    }

    public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { finish(u) }
    public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { finish(u) }
    private func finish(_ u: AVSpeechUtterance) {
        let call = pending.removeValue(forKey: ObjectIdentifier(u))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.deactivate() }
        call?.resolve()
    }
}
