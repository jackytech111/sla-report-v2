class SlaReportsController < ApplicationController
  # GET /api/requests (level 4): filters, sorting and cursor pagination, see docs/contract.md.
  def index
    render json: { error: "not implemented" }, status: :not_implemented
  end

  # GET /api/sla-report?from=YYYY-MM-DD&to=YYYY-MM-DD
  def show
    # TODO: implement the response-time report here.
    # Query params: params[:from], params[:to].
    # Use HelpdeskClient (app/services/helpdesk_client.rb) to call the helpdesk API.
    render json: { error: "not implemented" }, status: :not_implemented
  end
end
