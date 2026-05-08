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
  version "1.8.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "f3ce46585f8591c98723b8661fc5c913d29d3ee41da7fa561cb4185724e52286"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "5ad46845b5c17e4c988b53808f982caedab347ba9fbc6ee3e7da48b059487a4a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "294ccbb27e776649c47bd2b41b9948c37773829e82e448ec9ea141b991053165"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "53dcc3ad89029fbb944a89d3285f18911e4911d4d146d9f90c382e3a65a56016"
    end
  end

  depends_on "vips"

  def install
    bin.install Dir["localpress*"].first => "localpress"

    # Install sharp globally so the compiled binary can find it at runtime.
    # sharp is a native module that can't be bundled into single-file binaries.
    system "npm", "install", "-g", "sharp"
  end

  def caveats
    <<~EOS
      localpress requires sharp for image processing.
      It was installed globally via npm during formula installation.

      If you encounter issues, reinstall with:
        npm install -g sharp

      Verify with:
        localpress doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end
