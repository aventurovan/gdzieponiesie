import UIKit
import Capacitor

// Rejestracja lokalnej wtyczki (Capacitor 6+): storyboard wskazuje na tę klasę
class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }
}
