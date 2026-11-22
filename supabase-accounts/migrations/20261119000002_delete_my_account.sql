-- Lets a signed-in person delete their own Canopy account (Settings > You > Delete Account). It removes
-- their auth user; their profiles row goes with it (on delete cascade). Only ever their own: auth.uid().
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
