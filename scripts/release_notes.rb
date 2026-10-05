# Store release notes, shared by ios/fastlane/Fastfile and android/fastlane/Fastfile.
#
# CI passes the GitHub Release body (Markdown) in RELEASE_NOTES. Neither store
# renders Markdown, so it is flattened to plain text and GitHub's auto-generated
# contributor lines are dropped.

module ReleaseNotes
  module_function

  # Plain-text notes, or nil when the release has none.
  def from_env
    text = ENV["RELEASE_NOTES"].to_s.delete("\r")
      .split(/^#+\s*New Contributors|^\*\*Full Changelog\*\*/).first.to_s
      .gsub(/^#+\s*/, "")                          # headings
      .gsub(/\*\*(.+?)\*\*/, '\1')                 # bold
      .gsub(/\[([^\]]*)\]\([^)]*\)/, '\1')         # links
      .gsub(%r{ by @[\w-]+ in https://\S+}, "")    # "by @x in <PR url>"
      .strip
    text.empty? ? nil : text
  end
end
