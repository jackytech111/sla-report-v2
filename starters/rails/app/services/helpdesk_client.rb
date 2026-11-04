require "json"
require "net/http"
require "uri"

# Minimal helpdesk API client. Extend as needed.
class HelpdeskClient
  class Error < StandardError; end

  def initialize(base_url: ENV.fetch("HELPDESK_URL", "http://localhost:4010"),
                 token: ENV.fetch("HELPDESK_TOKEN", ""))
    @base_url = base_url.chomp("/")
    @token = token
  end

  # GET a path (e.g. "/some/endpoint") with optional query params; returns parsed JSON.
  # Raises HelpdeskClient::Error on a non-2xx response.
  def get(path, params = {})
    uri = URI(@base_url + path)
    uri.query = URI.encode_www_form(params) unless params.empty?

    request = Net::HTTP::Get.new(uri)
    request["Authorization"] = "Bearer #{@token}"
    request["Accept"] = "application/json"

    response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                               open_timeout: 5, read_timeout: 10) do |http|
      http.request(request)
    end

    unless response.is_a?(Net::HTTPSuccess)
      raise Error, "Helpdesk API GET #{uri} failed: #{response.code} #{response.body}"
    end

    JSON.parse(response.body)
  end
end
