import { AppMenuPositioner } from "../components/PopupPositioner";
import { Menu } from '@base-ui/react/menu';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { CROP_MENU_COMMAND_IDS, useCanEditCrop } from '../commands/cropCommands';
import { SCALE_MENU_COMMAND_IDS, useCanScaleLayer } from '../commands/scaleCommands';
import { CommandContextItem } from '../menu/CommandContextItem';
import { contextMenuFinalFocus, MenuSeparator } from '../menu/Menu';
import { useCursorAnchor } from '../timeline/contextMenuAnchor';

export function PreviewContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const cropAvailable = useCanEditCrop();
  const scaleAvailable = useCanScaleLayer();
  const available = cropAvailable || scaleAvailable;
  useEffect(() => { if (!available) onClose(); }, [available, onClose]);
  return <Menu.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <Menu.Portal>
      <AppMenuPositioner anchor={anchor} side="bottom" align="start" sideOffset={0} className="app-popup-positioner">
        <Menu.Popup className="app-menu-list" aria-label={t('layer_scale.menu_title')} finalFocus={contextMenuFinalFocus}>
          {scaleAvailable && SCALE_MENU_COMMAND_IDS.map(id => <CommandContextItem key={id} id={id} onRun={onClose} />)}
          {scaleAvailable && cropAvailable && <MenuSeparator />}
          {cropAvailable && CROP_MENU_COMMAND_IDS.map(id => <CommandContextItem key={id} id={id} onRun={onClose} />)}
        </Menu.Popup>
      </AppMenuPositioner>
    </Menu.Portal>
  </Menu.Root>;
}
