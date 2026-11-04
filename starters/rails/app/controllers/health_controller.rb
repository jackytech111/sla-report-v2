class HealthController < ApplicationController
  def show
    render json: { ok: true }
  end

  # TODO: answer 200 {"ready": true} once your app can serve six-month reports (level 2).
  def ready
    render json: { ready: false }, status: :service_unavailable
  end
end
