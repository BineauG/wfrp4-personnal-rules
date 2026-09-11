# wfrp4-personnal-rules

Module personnel pour Foundry VTT 13+ et le systeme WFRP4E. Il regroupe plusieurs regles de table autour des marchands Item Piles, de la disponibilite, des portes verrouillees et des difficultes.

## Compatibilite

- Foundry VTT 13+
- Systeme `wfrp4e`
- Modules requis : `item-piles`, `item-piles-wfrp4e`, `socketlib`

L'identifiant du module, son nom affiche et son dossier sont `wfrp4-personnal-rules`. Les reglages et flags utilisent ce nouvel identifiant. Pour un monde utilisant l'ancienne version, desactivez l'ancien module et reconfigurez les parametres, marchands et portes : les anciennes donnees ne sont pas migrees automatiquement.

## Marchands Item Piles et negociation

Le module intercepte les achats et ventes entre un acteur joueur et un marchand Item Piles WFRP4E.

### Acheter a un marchand

- Le joueur choisit `Haggle`, `Evaluate`, ou `Ne pas negocier`.
- En cas de negociation, le joueur lance son test normal via la boite de dialogue WFRP4E.
- Le marchand oppose avec `Haggle`.
- Si le joueur gagne le test oppose, le prix d'achat baisse de `DR oppose x 5%`.
- Une option de module permet au marchand de lancer automatiquement son jet oppose, pour eviter une action manuelle du MJ.

### Vendre a un marchand

- Le joueur peut negocier avec `Haggle`, ou vendre sans negociation.
- Le marchand oppose avec sa meilleure competence entre `Haggle` et `Evaluate`.
- Si le joueur gagne le test oppose, le prix de vente augmente de `DR oppose x 10%`.
- Le prix de vente part du prix affiche par le vendeur Item Piles.
- Si le marchand possede deja l'objet en stock disponible, le prix de vente de base est divise par deux.

### Configuration de negociation

- La negociation peut etre activee ou desactivee globalement dans les parametres du module.
- Chaque acteur marchand dispose aussi d'une case de configuration pour activer ou desactiver la negociation uniquement pour lui.

## Disponibilite des objets

Quand un PNJ marchand Item Piles est cree ou configure, le module peut lancer automatiquement les tests de disponibilite WFRP4E pour ses objets.

- La taille de localite par defaut se regle dans les parametres du module.
- La taille de localite peut aussi etre modifiee dans l'interface de configuration du vendeur.
- Changer la localite d'un vendeur relance la disponibilite de ses articles.
- Les objets indisponibles peuvent etre marques comme non vendables, et eventuellement masques.
- Un resume peut etre poste dans le chat pour le MJ.

## Difficultes personnalisees

Au chargement, le module remplace les difficultes WFRP4E par la table suivante :

| Cle | Libelle | Modificateur |
| --- | --- | ---: |
| `veasy` | Tres Facile | +60 |
| `easy` | Facile | +40 |
| `banal` | Banal | +30 |
| `average` | Accessible | +20 |
| `medium` | Faisable | +10 |
| `challenging` | Intermediaire | +0 |
| `difficult` | Complexe | -10 |
| `hard` | Difficile | -20 |
| `vhard` | Tres Difficile | -30 |
| `doom` | Maudit | -40 |
| `impossible` | Impossible | -50 |

## Lore de Tzeentch

Le module injecte l'effet manquant du `Lore of Tzeentch` dans les effets de Lore WFRP4E.

- Les sorts avec le lore `tzeentch` recuperent un bouton natif `Apply Effect`.
- Cliquer sur ce bouton applique l'effet a la cible du sort.
- La cible lance un test d'Endurance `Intermediaire (+0)`.
- En cas d'echec, la cible gagne `+1 Corruption`.
- En cas de reussite, la cible gagne `+1 Fortune`.

## Portes verrouillees

Quand un joueur clique sur une porte verrouillee, le module ouvre une boite de dialogue d'action.

- `Crocheter` est disponible si l'acteur possede la competence `Pick Lock`.
- `Enfoncer` utilise `Melee (Brawling)` ou une arme adaptee selectionnee dans la boite de dialogue.
- Le MJ peut configurer une porte avec `Maj + clic droit`.
- Une porte configuree utilise les valeurs `D`, `SL`, `TB` et `W`.
- Un crochetage reussi deverrouille automatiquement la porte.
- Pour enfoncer une porte, le module applique `Bonus de Force + DR`, plus la moitie des degats de l'arme si une arme est utilisee, puis compare au `TB` de la porte.
- Quand les Blessures de la porte tombent a 0, la porte s'ouvre automatiquement.

## Monnaie

Les soldes des deux acteurs sont calcules et verifies avant tout transfert. Si les denominations presentes ne permettent pas de representer exactement un solde, l'echange est annule sans deplacer les objets ni la monnaie. Ajoutez a l'acteur un objet de monnaie valant 1 penny, meme de quantite nulle, pour permettre le rendu exact. Les marchands a monnaie infinie restent pris en charge.

## Developpement

Aucune dependance a installer. Verification avec Node.js :

```sh
node --check scripts/main.js
node --test tests/money.test.cjs
```

API de macros : `game.modules.get("wfrp4-personnal-rules").api` (`rollAvailability`, `negotiateTrade`, `configureDoor`).
