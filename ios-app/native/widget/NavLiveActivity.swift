import ActivityKit
import WidgetKit
import SwiftUI

func maneuverSymbol(_ t: Int) -> String {
    switch t {
    case 0: return "arrow.turn.up.left"
    case 1: return "arrow.turn.up.right"
    case 2: return "arrow.uturn.left"
    case 3: return "arrow.uturn.right"
    case 4: return "arrow.up.left"
    case 5: return "arrow.up.right"
    case 7: return "arrow.triangle.turn.up.right.circle"
    case 8: return "arrow.triangle.turn.up.right.circle.fill"
    case 9: return "arrow.uturn.backward"
    case 10: return "flag.checkered"
    case 12: return "arrow.up.left"
    case 13: return "arrow.up.right"
    default: return "arrow.up"
    }
}

struct NavLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NavAttributes.self) { context in
            // Ekran blokady / baner
            VStack(spacing: 8) {
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: maneuverSymbol(context.state.maneuver))
                        .font(.system(size: 38, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.dist).font(.system(size: 34, weight: .heavy)).foregroundStyle(.white)
                        Text(context.state.instr).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white.opacity(0.9)).lineLimit(1)
                    }
                    Spacer()
                    if context.state.limit > 0 {
                        ZStack {
                            Circle().fill(.white)
                            Circle().stroke(Color(red: 0.85, green: 0.18, blue: 0.13), lineWidth: 6)
                            Text("\(context.state.limit)").font(.system(size: 20, weight: .heavy)).foregroundStyle(.black)
                        }.frame(width: 54, height: 54)
                    }
                }
                ProgressView(value: context.state.progress).tint(.white).scaleEffect(x: 1, y: 1.4, anchor: .center)
                HStack {
                    Text("Azimo").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                    Spacer()
                    Text(context.state.remKm).font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    Text(context.state.remTime).font(.system(size: 15, weight: .bold)).foregroundStyle(Color(red: 0.49, green: 0.89, blue: 0.55))
                    Text(context.state.eta).font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    if !context.state.delay.isEmpty {
                        Text(context.state.delay).font(.system(size: 13, weight: .bold)).foregroundStyle(Color(red: 0.95, green: 0.64, blue: 0.23))
                    }
                }
            }
            .padding(14)
            .activityBackgroundTint(Color(red: 0.09, green: 0.11, blue: 0.17))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: maneuverSymbol(context.state.maneuver)).font(.system(size: 28, weight: .bold))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.dist).font(.system(size: 24, weight: .heavy))
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.instr).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(context.state.remKm).font(.caption.bold())
                        Spacer()
                        Text(context.state.remTime).font(.caption.bold()).foregroundStyle(.green)
                        Spacer()
                        Text(context.state.eta).font(.caption.bold())
                    }
                }
            } compactLeading: {
                Image(systemName: maneuverSymbol(context.state.maneuver)).font(.system(size: 16, weight: .bold))
            } compactTrailing: {
                Text(context.state.dist).font(.system(size: 14, weight: .heavy))
            } minimal: {
                Image(systemName: maneuverSymbol(context.state.maneuver)).font(.system(size: 14, weight: .bold))
            }
            .keylineTint(Color(red: 0.23, green: 0.45, blue: 1.0))
        }
    }
}
