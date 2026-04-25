require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "SiraSupport"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://sira-screen-share.com"
  s.license      = "MIT"
  s.authors      = { "Sira" => "engineering@sira-screen-share.com" }
  s.platforms    = { :ios => "13.0" }
  s.source       = { :git => "https://github.com/sira/support-react-native.git", :tag => "#{s.version}" }
  s.source_files = "ios/**/*.{h,m,swift}"
  s.swift_version = "5.0"
  s.frameworks   = "ReplayKit", "UIKit", "CoreImage", "ImageIO"

  s.dependency "React-Core"
end
