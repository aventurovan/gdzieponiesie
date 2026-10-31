# Dodaje do projektu Capacitor: rozszerzenie widgetu (Live Activity) + wtyczkę w aplikacji.
require 'xcodeproj'
proj_path = ARGV[0] || 'ios/App/App.xcodeproj'
native = File.expand_path(ARGV[1] || 'native')
project = Xcodeproj::Project.open(proj_path)
app = project.targets.find { |t| t.name == 'App' }
raise 'brak targetu App' unless app
app_group = project.main_group.find_subpath('App', true)

# --- pliki wtyczki + atrybuty do aplikacji
plugin_group = app_group.new_group('Native')
%w[plugin/LiveActivityPlugin.swift plugin/MyViewController.swift NavAttributes.swift].each do |rel|
  ref = plugin_group.new_file(File.join(native, rel))
  app.source_build_phase.add_file_reference(ref)
end

# --- target rozszerzenia
ext = project.new_target(:app_extension, 'NavWidget', :ios, '16.2')
ext_group = project.main_group.new_group('NavWidget')
%w[widget/NavWidgetBundle.swift widget/NavLiveActivity.swift NavAttributes.swift].each do |rel|
  ref = ext_group.new_file(File.join(native, rel))
  ext.source_build_phase.add_file_reference(ref)
end
plist = ext_group.new_file(File.join(native, 'widget/Info.plist'))
ext.build_configurations.each do |c|
  c.build_settings['INFOPLIST_FILE'] = plist.real_path.to_s
  c.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'pl.gdzieponiesie.gps.NavWidget'
  c.build_settings['SWIFT_VERSION'] = '5.0'
  c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.2'
  c.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  c.build_settings['SKIP_INSTALL'] = 'YES'
  c.build_settings['MARKETING_VERSION'] = '1.0'
  c.build_settings['CURRENT_PROJECT_VERSION'] = '1'
  c.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  c.build_settings['CODE_SIGNING_REQUIRED'] = 'NO'
  c.build_settings['LD_RUNPATH_SEARCH_PATHS'] = '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'
  c.build_settings['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = ''
  c.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
end
%w[SwiftUI WidgetKit ActivityKit].each do |fw|
  ext.add_system_framework(fw)
end

# --- osadzenie rozszerzenia w aplikacji
app.add_dependency(ext)
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
bf = embed.add_file_reference(ext.product_reference)
bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

# --- aplikacja: wersja Swift, Live Activities, deployment target
app.build_configurations.each do |c|
  c.build_settings['SWIFT_VERSION'] ||= '5.0'
  c.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.2'
end
project.save
puts 'OK: NavWidget dodany'
