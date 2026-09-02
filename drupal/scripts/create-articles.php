<?php
use Drupal\node\Entity\Node;
use Drupal\file\Entity\File;

// A small generated JPEG so the image field has a real file behind it.
$dir = 'public://snapshot';
\Drupal::service('file_system')->prepareDirectory($dir, \Drupal\Core\File\FileSystemInterface::CREATE_DIRECTORY);

function make_image(string $name, int $w, int $h): int {
  $im = imagecreatetruecolor($w, $h);
  imagefill($im, 0, 0, imagecolorallocate($im, 30 + ($w % 200), 90, 160));
  $tmp = sys_get_temp_dir() . "/$name";
  imagejpeg($im, $tmp, 82);
  imagedestroy($im);
  $data = file_get_contents($tmp);
  $file = \Drupal::service('file.repository')->writeData($data, "public://snapshot/$name", \Drupal\Core\File\FileExists::Replace);
  $file->setPermanent();
  $file->save();
  return (int) $file->id();
}

$rows = [
  ['Decoupling Drupal without losing the editorial workflow',
   '<p>Preview, revisions and menus are the parts a headless front end usually drops. They are also the parts editors notice first.</p><p>This article walks through keeping them.</p>',
   'Editor previewing an unpublished article', TRUE],
  ['Why JSON:API responses are a graph, not a view model',
   '<p>Relationships arrive as <code>{type, id}</code> pointers and the objects behind them sit in a sibling <code>included</code> array.</p>',
   'Diagram of a normalised JSON:API document', TRUE],
  ['Caching a decoupled site without serving stale drafts',
   '<p>Stale-while-revalidate on published content, and no caching whatsoever on preview.</p>',
   'Cache invalidation flowing from Drupal to the front end', TRUE],
  ['An article with no image at all',
   '<p>Every mapper has to cope with an empty relationship, so the snapshot contains one.</p>',
   NULL, TRUE],
  ['A draft that must never reach the public',
   '<p>Unpublished on purpose: the fixtures need a resource the published filter has to exclude.</p>',
   NULL, FALSE],
];

$i = 0;
foreach ($rows as [$title, $body, $alt, $published]) {
  $i++;
  $values = [
    'type' => 'article',
    'title' => $title,
    'body' => ['value' => $body, 'format' => 'basic_html'],
    'status' => $published,
    'created' => strtotime("-{$i} days"),
    'path' => ['alias' => '/blog/' . preg_replace('/[^a-z0-9]+/', '-', strtolower(substr($title, 0, 40)))],
  ];
  if ($alt !== NULL) {
    $fid = make_image("cover-$i.jpg", 1200 + $i, 630);
    $values['field_image'] = ['target_id' => $fid, 'alt' => $alt, 'title' => ''];
  }
  Node::create($values)->save();
  print "created: $title\n";
}
