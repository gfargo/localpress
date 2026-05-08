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
  version "1.10.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "f4021a530b008e2b3ad0b5407933314bf862919e4ea15d798677fd4ec51dc985"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "dbe23d600a5cf04613174565743ca08dc1332a1096d25a819de3ecda7409cfbe"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "4c94285e1649f067b93e38cda2ad4c413a25a9c5c6c640852459250364eabb29"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "28e6bc53344fbbd87564ad535438bb393d3dcf59eba347e7d1ef73845e068a94"
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
