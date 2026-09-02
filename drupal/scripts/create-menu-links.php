<?php
use Drupal\menu_link_content\Entity\MenuLinkContent;

// Core's `standard` profile ships menus but no menu_link_content entities:
// its default links are code-defined plugins, which JSON:API does not expose.
// A decoupled front end reads editorial menu links, so the snapshot needs some.
$about = MenuLinkContent::create([
  'title' => 'About',
  'link' => ['uri' => 'internal:/about'],
  'menu_name' => 'main',
  'weight' => 0,
  'expanded' => TRUE,
]);
$about->save();

$rows = [
  ['Articles', 'internal:/articles', NULL, -10],
  ['Our team', 'internal:/about/team', 'menu_link_content:' . $about->uuid(), 0],
  ['How we work', 'internal:/about/process', 'menu_link_content:' . $about->uuid(), -5],
  ['Contact', 'internal:/contact', NULL, 10],
];

foreach ($rows as [$title, $uri, $parent, $weight]) {
  $values = [
    'title' => $title,
    'link' => ['uri' => $uri],
    'menu_name' => 'main',
    'weight' => $weight,
  ];
  if ($parent !== NULL) {
    $values['parent'] = $parent;
  }
  MenuLinkContent::create($values)->save();
  print "menu link: $title\n";
}
print "menu link: About\n";
