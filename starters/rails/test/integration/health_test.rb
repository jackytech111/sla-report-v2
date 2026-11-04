require "test_helper"

class HealthTest < ActionDispatch::IntegrationTest
  test "GET /health returns ok" do
    get "/health"
    assert_response :ok
    assert_equal({ "ok" => true }, response.parsed_body)
  end
end
