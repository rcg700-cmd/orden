# orden

Ordena carpetas con **plan previo**, **interfaz de escritorio** y **undo real**. Nada se mueve sin confirmación y todo movimiento queda registrado en un diario reversible.

## Requisitos

- Windows (probado) · Node.js 24+
- Sin dependencias de runtime: el motor usa solo módulos nativos de Node.

## Instalación

```powershell
npm install
```

Si tu npm bloquea los scripts de instalación (`allow-scripts`), Electron no descarga su binario:

```powershell
npm approve-scripts electron
npm rebuild electron
```

## App de escritorio

```powershell
npm run desktop
```

Flujo:

1. **Elegir carpeta…** (o la que tengas abierta).
2. Revisa el plan agrupado por regla: origen → destino y tamaño.
3. Desmarca lo que quieras conservar.
4. **Aplicar N** → confirmación → mueve y guarda el diario.
5. **Deshacer** → restaura la última acción completa.

La ventana es Electron (sin compiladores). La UI es HTML/CSS/JS plano; el proceso principal reutiliza el mismo motor que la CLI.

## CLI

```powershell
npm start -- init                 # crea orden.config.json
npm start -- scan ~/Downloads     # plan, solo lectura
npm start -- apply ~/Downloads    # aplica con confirmación
npm start -- undo --list          # diarios disponibles
npm start -- undo                 # revierte el último apply
npm start -- dupes --min-size 1mb # duplicados por SHA-256
```

Opciones: `--json`, `--dry-run`, `--yes`, `--verbose`, `--limit`, `--config`, `--root`.

Códigos de salida: `0` correcto · `1` algún archivo falló · `2` error de uso/configuración.

## Configuración

`orden.config.json`:

```json
{
  "root": ".",
  "includeHidden": false,
  "ignore": ["node_modules/**", "*.tmp"],
  "rules": [
    {
      "name": "Imágenes",
      "dest": "Imagenes/{year}/{month}",
      "match": { "ext": ["jpg", "png"] }
    },
    {
      "name": "Zips antiguos",
      "dest": "Archivo muerto/{year}",
      "match": { "ext": ["zip"], "olderThanDays": 365 }
    },
    {
      "name": "Capturas",
      "dest": "Capturas",
      "match": { "glob": ["captura-*.png"] }
    }
  ]
}
```

- Gana la **primera regla** que coincida; dentro de `match`, todas las condiciones se cumplen (AND) y dentro de una lista basta una (OR).
- `ext`: extensión sin punto, sin distinguir mayúsculas.
- `glob`: `*`, `**`, `?`, `[abc]` sobre la ruta relativa.
- `olderThanDays`: usa la fecha de modificación del archivo.
- `minSizeBytes`: tamaño mínimo.
- Tokens en `dest`: `{year}`, `{month}`, `{ext}` (según la fecha del archivo).
- `dest` debe ser relativo y quedarse dentro de la carpeta: se rechaza `..`, rutas absolutas y unidades de Windows.

Si no hay `orden.config.json`, la app usa las reglas por defecto (imágenes, documentos, comprimidos, instaladores, vídeo, audio, código).

## Seguridad

- `scan` es solo lectura; `apply` pide confirmación salvo `--yes`.
- Nunca sobrescribe: si el destino existe, usa `nombre (1).ext`.
- Nunca borra archivos. `undo` solo borra carpetas que quedaron vacías.
- Cada movimiento se escribe en `.declutter/journal/<id>.json` antes de continuar; si el proceso muere, lo hecho sigue siendo reversible.
- Las rutas se validan contra la raíz en cada paso (falla cerrado).
- `undo` restaura en orden inverso y conserva fechas.

## Estructura

```
src/            motor: config, reglas, scan, apply, undo, dupes
bin/orden.mjs   entrada CLI
desktop/        main (Electron), preload, UI
scripts/        build del escritorio (esbuild)
tests/          pruebas del motor (node:test)
```

## Desarrollo

```powershell
npm run check        # typecheck + tests del motor
npm run build:desktop # bundle del proceso principal (esbuild)
```

Smoke test de la interfaz (sin mostrar ventana, con captura opcional):

```powershell
npm run build:desktop
.\node_modules\electron\dist\electron.exe . --smoke-root="C:\ruta\fixture" --smoke-shot="$env:TEMP\shot.png" --smoke-log="$env:TEMP\smoke.log"
```

Abre la carpeta, aplica todo, deshace, y escribe el resultado en el log. Útil para verificar la UI sin tocar archivos reales.

## Limitaciones

- No vigila carpetas en segundo plano.
- `dupes` solo informa; no borra ni enlaza duplicados.
- Solo mueve dentro de la carpeta raíz elegida.
- Empaquetado como `.exe` instalable pendiente (electron-builder).
