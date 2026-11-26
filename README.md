# Llibre 3D Studio

Webapp interactiva per visualitzar, animar i exportar llibres en 3D en **4K UHD (3840 × 2160)** a **50 fps** juntament amb el seu **mapa Alpha Blanc i Negre (Luma Matte)** sincronitzat fotograma a fotograma.

## Funcionalitats principals

- **Detecció automàtica de PDFs d'impremta**: llegeix el `TrimBox` dels PDFs de portada (contraportada + llom + portada) i pàgines interiors, elimina automàticament les marques de tall i sagnat, i calcula format i amplada del llom.
- **Tapa Dura vs. Tapa Normal**: gruix de tapa dura configurable, ceja (*overhang*), hendits, capçaletes i doblecs interiors (*turn-ins*) de la portada.
- **Timeline visual interactiva (3 pistes)**:
  - Clips arrossegables i redimensionables (*Obrir llibre*, *Passar pàgines*, *Tancar llibre*, *Volta 360º/180º* horari o antihorari amb corbes de frenada).
  - *Hover skimming* en passar el ratolí per damunt la timeline.
  - Navegació frame a frame (`←` / `→`), pausa amb `Espai`, i **Desfer / Refer** (`Cmd+Z` / `Cmd+Shift+Z`).
- **Projectes JSON**: exportar i importar tota la configuració i la timeline del projecte.
- **Exportació 4K + Alpha B/N**: renderització offline frame a frame amb WebCodecs (`MP4 H.264` / `WebM VP9`) amb enquadrament exacte al marc `16:9` / `1:1` / `9:16`.

## Com executar-ho en local

```bash
ruby server.rb 8765
```

I obre `http://localhost:8765` al navegador.
