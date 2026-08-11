FROM datadog/agent:7@sha256:c778490306882f4ed64ff61f5fe8d841ed9061ab52c19edf2afe0f3ba84ab650

COPY checks.d/railway_logs.py /etc/datadog-agent/checks.d/railway_logs.py
COPY checks.d/railway_logs_core.py /etc/datadog-agent/checks.d/railway_logs_core.py
COPY conf.d/railway_logs.d/conf.yaml /etc/datadog-agent/conf.d/railway_logs.d/conf.yaml
