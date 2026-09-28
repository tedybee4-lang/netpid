-- Auto-provision per-ISP defaults: sms_settings + templates on ISP create
create or replace function public.provision_isp_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.sms_settings (isp_id) values (new.id) on conflict (isp_id) do nothing;
  insert into public.sms_templates (isp_id, event, locale, body) values
    (new.id, 'welcome', 'en', 'Welcome! Your account is registered. Pay via M-Pesa to activate.'),
    (new.id, 'payment_received', 'en', 'Payment received. Receipt available in your portal. Thank you!'),
    (new.id, 'package_activated', 'en', 'Your package is now active. Thank you for choosing us!'),
    (new.id, 'package_expiring', 'en', 'Reminder: your package expires soon. Renew via M-Pesa to stay connected.'),
    (new.id, 'package_expired', 'en', 'Your package has expired. Renew now to restore service.'),
    (new.id, 'suspension', 'en', 'Your account has been suspended. Contact support for help.')
  on conflict (isp_id, event, locale) do nothing;
  return new;
end $$;
drop trigger if exists trg_isps_defaults on public.isps;
create trigger trg_isps_defaults after insert on public.isps
  for each row execute function public.provision_isp_defaults();
