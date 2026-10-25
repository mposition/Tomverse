Pod::Spec.new do |s|
  s.name = 'TomverseMobileAuth'
  s.version = '0.1.0'
  s.summary = 'Native-only Tomverse session storage and PKCE sign-in'
  s.license = { :type => 'Private' }
  s.homepage = 'https://tomverse.app'
  s.author = 'Tomverse'
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/MobileAuth/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
