# typed: false
# frozen_string_literal: true

# This formula is maintained in the localpress repository.
# The Homebrew tap lives at https://github.com/gfargo/homebrew-localpress
#
# To install:
#   brew tap gfargo/localpress
#   brew install localpress
#
# Or in one step:
#   brew install gfargo/localpress/localpress

class Localpress < Formula
  desc "Local-compute WordPress media optimization. Your laptop, your library."
  homepage "https://github.com/gfargo/localpress"
  version "1.4.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "286352e36906eafedbc9c42dde4cd453e588de67e8b3399d08c2483a471bfaf9"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "2db0e91e8f3f8f40cd9ef6fa8f0c69ff912105577dd6a77292e15a1586515e01"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "1580f186a8a6e981d3d07280d5f3bf3823f2ffc611ca87d3dee0c1da949c90e9"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "a9fe774b97a13f5074ccf6051be441a96378d5cf9d36c0edaf454b9262d9579a"
    end
  end

  def install
    bin.install Dir["localpress*"].first => "localpress"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end
