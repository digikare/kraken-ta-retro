# Kraken ta rétro

Une rétrospective du voilier (*Sailboat Retrospective*) : des notes, des thèmes,
des votes et un plan d’action.

Construit chez Digikare pour nos quatre rétrospectives annuelles.
[Pourquoi KRAKEN](HISTORY.md).

## Démarrer

Node.js 24 ou supérieur. Aucune dépendance à installer.

```sh
npm start
```

Ouvrir [localhost:8787](http://localhost:8787). Les autres participants utilisent
l’adresse réseau affichée dans le terminal.

## IA facultative

L’IA propose de regrouper les notes en thèmes pour faciliter les votes,
puis la définition du plan d’action par l’équipe. L’équipe valide les regroupements.

Copier `.env.example` vers `.env`, renseigner `IA_KEY`, puis redémarrer.
`IA_URL` et `IA_MODEL` permettent de choisir le fournisseur et le modèle.
Les textes des notes sont transmis au fournisseur configuré pour cette aide.
Sans clé, la rétro fonctionne sans IA.

## À savoir

- Les sessions sont conservées dans `data/` : sauvegarder ce dossier pour les garder.
- `.env` et `data/` sont exclus de Git.
- Une session de démonstration est disponible dans `examples/retro-demo.json`, à importer dans l’interface.
- Développement : `npm run dev`. Vérification de syntaxe du serveur : `npm run check`.

Licence [MIT](LICENSE) — © 2026 Digikare.
