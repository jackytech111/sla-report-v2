require_relative "boot"

require "rails"
require "action_controller/railtie"
require "rails/test_unit/railtie"

Bundler.require(*Rails.groups)

module SlaReport
  class Application < Rails::Application
    config.load_defaults 8.0
    config.api_only = true

    # Serve public/index.html at "/" in every environment.
    config.public_file_server.enabled = true

    # Dummy secret so the app boots without credentials/master.key.
    # Fine for this take-home only: never use a hard-coded secret in a real app.
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE", "takehome-dummy-secret-key-base-not-for-production")

    config.logger = ActiveSupport::TaggedLogging.logger($stdout)
  end
end
