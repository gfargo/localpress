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
  version "1.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "d88ccf737df627432013526edf48d3d896fd3076bcafdd77cfdd88f435b0cc0f"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "52e74b1991724dd67c721f6d7a8a033ee576a98368d47c32a5b7cedc006af9bd"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "85ac583dbe01e59f66b486ff70c470dc495754577ad1497fc8076fb1455a9ba6"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "07946c8abe8504417fcea57569310bc949bfa7a5d5905cfe07d30ee2edffefff"
    end
  end

  def install
    bin.install Dir["localpress*"].first => "localpress"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end
