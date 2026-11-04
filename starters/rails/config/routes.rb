Rails.application.routes.draw do
  get "/health", to: "health#show"
  get "/ready", to: "health#ready"
  get "/api/sla-report", to: "sla_reports#show"
  get "/api/requests", to: "sla_reports#index"
end
