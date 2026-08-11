# pi-hooks

Run deterministic scripts during the Pi lifecycle.

## Helper asset directory naming

Pi Hooks configuration files remain:

- `~/.pi/hooks.json`
- `<project>/.pi/hooks.json`

Pi Hooks-owned helper assets under `.pi` should live in:

- `~/.pi/pi-hooks/`
- `<project>/.pi/pi-hooks/`

That avoids collision with Pi-native extension migration behavior for `.pi/hooks/`.
