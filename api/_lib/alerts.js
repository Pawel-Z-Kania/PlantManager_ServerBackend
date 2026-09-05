// Wspólna reguła wyliczania alertów (brak połączenia + poziom baterii) na podstawie progów
// z system_config, żeby pots.js i watchdog.js nie mogły się już rozjechać w progach/logice.
export function computeAlerts(pot, config, now = new Date()) {
  const alerts = [];

  if (pot.last_signal_time) {
    const lastSignal = new Date(pot.last_signal_time);
    const diffHours = (now - lastSignal) / (1000 * 60 * 60);

    if (diffHours >= config.connection_timeout_hours) {
      alerts.push({
        code: 'DISCONNECTION',
        label: 'Brak połączenia',
        severity: 'error',
        icon: 'wifi_off',
      });
    }
  } else {
    alerts.push({
      code: 'DISCONNECTION',
      label: 'Brak połączenia',
      severity: 'error',
      icon: 'wifi_off',
    });
  }

  if (pot.battery_mv != null) {
    if (pot.battery_mv < config.battery_critical_mv) {
      alerts.push({
        code: 'CRITICAL_BATTERY',
        label: `Bateria ${pot.battery_mv}mV`,
        severity: 'error',
        icon: 'battery_0_bar',
      });
    } else if (pot.battery_mv <= config.battery_warning_mv) {
      alerts.push({
        code: 'LOW_BATTERY',
        label: `Bateria ${pot.battery_mv}mV`,
        severity: 'warning',
        icon: 'battery_3_bar',
      });
    }
  }

  return alerts;
}
