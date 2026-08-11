FROM datadog/agent:7

COPY datadog.yaml /etc/datadog-agent/datadog.yaml
COPY conf.d/syslog.d/conf.yaml /etc/datadog-agent/conf.d/syslog.d/conf.yaml

# Private-network listeners only. Railway creates no public domain or TCP proxy.
EXPOSE 8125/udp
EXPOSE 514/udp
EXPOSE 515/udp
