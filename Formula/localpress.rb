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
  version "1.10.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "e7e06f981701f6e5eac360b734db118d1ae9afdc021135a5208911aa08694c43"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "cf56edbad6fe8297ca2b5a77794bfc521f1b4e84c29413a2137045b10b9d547a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "17d673d1ad87ea5c9b5f801e1921abad680ec57a78adf37106c88f17e88f1cd7"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "390dda1c6a9d18ec30a3669d255222d611fc44196f24a76ee9cf7ce3e606dbfd"
    end
  end

  def install
    bin.install Dir["localpress*"].first => "localpress"
  end

  def caveats
    <<~EOS
      localpress uses sharp (libvips) for image processing.

      On first use of optimize/convert/resize/remove-bg, localpress will
      check if sharp is installed globally and offer to install it for you.

      You can also install it manually at any time:
        bun install -g sharp
        # or:
        npm install -g sharp

      Run `localpress doctor` to verify your setup.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end
